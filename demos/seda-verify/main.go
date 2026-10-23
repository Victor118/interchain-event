// seda-verify checks, off-chain and read-only, that a SEDA data result can be
// proven against the Cosmos Hub's IBC light client of seda-1.
//
// It replays exactly what the Hub would run for
// /ibc.core.client.v1.Query/VerifyMembership (07-tendermint verifyMembership):
//
//	merkleProof.VerifyMembership(clientState.ProofSpecs, consensusState.Root, merklePath, value)
//
// with the client state and consensus state read from the Hub, and the proof
// and value read from SEDA at the matching height.
package main

import (
	"context"
	"crypto/tls"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"time"

	"cosmossdk.io/collections"
	rpcclient "github.com/cometbft/cometbft/rpc/client"
	rpchttp "github.com/cometbft/cometbft/rpc/client/http"
	"github.com/cosmos/cosmos-sdk/types/query"
	"github.com/cosmos/gogoproto/proto"
	clienttypes "github.com/cosmos/ibc-go/v10/modules/core/02-client/types"
	commitmenttypes "github.com/cosmos/ibc-go/v10/modules/core/23-commitment/types"
	commitmenttypesv2 "github.com/cosmos/ibc-go/v10/modules/core/23-commitment/types/v2"
	ibctm "github.com/cosmos/ibc-go/v10/modules/light-clients/07-tendermint"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials"
	"google.golang.org/protobuf/encoding/protowire"
)

const (
	// SEDA x/batching store name and DataResultsPrefix (collections.NewPrefix(0)).
	sedaStoreName         = "batching"
	sedaDataResultsPrefix = 0x00
)

func main() {
	hubGRPC := flag.String("hub-grpc", "cosmos-grpc.publicnode.com:443", "Cosmos Hub gRPC endpoint (TLS)")
	clientID := flag.String("client-id", "07-tendermint-1372", "IBC client of seda-1 on the Cosmos Hub")
	sedaRPC := flag.String("seda-rpc", "https://seda-rpc.polkachu.com:443", "SEDA CometBFT RPC endpoint")
	sedaREST := flag.String("seda-rest", "https://seda-api.polkachu.com", "SEDA REST endpoint, used to look up dr_block_height")
	drID := flag.String("dr-id", "f5fd03de0637abee041dbf3bc2e23a8252ee81002c05ed5ea6729e6c2e89d3ac", "SEDA data request id")
	flag.Parse()

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	// 1. Trusted side: client state and latest consensus state from the Hub.
	conn, err := grpc.NewClient(*hubGRPC, grpc.WithTransportCredentials(credentials.NewTLS(&tls.Config{MinVersion: tls.VersionTLS12})))
	must(err)
	defer conn.Close()
	hub := clienttypes.NewQueryClient(conn)

	status, err := hub.ClientStatus(ctx, &clienttypes.QueryClientStatusRequest{ClientId: *clientID})
	must(err)
	step("Hub client %s status: %s", *clientID, status.Status)
	if status.Status != "Active" {
		log.Fatalf("client is not Active: VerifyMembership would refuse to verify")
	}

	csRes, err := hub.ClientState(ctx, &clienttypes.QueryClientStateRequest{ClientId: *clientID})
	must(err)
	clientState := &ibctm.ClientState{}
	must(proto.Unmarshal(csRes.ClientState.Value, clientState))
	if clientState.ChainId != "seda-1" {
		log.Fatalf("client %s tracks %s, not seda-1", *clientID, clientState.ChainId)
	}

	// The Hub only stores consensus states at heights where a relayer updated the client.
	heights, err := hub.ConsensusStateHeights(ctx, &clienttypes.QueryConsensusStateHeightsRequest{
		ClientId:   *clientID,
		Pagination: &query.PageRequest{Limit: 1, Reverse: true},
	})
	must(err)
	if len(heights.ConsensusStateHeights) == 0 {
		log.Fatalf("no consensus state stored for %s", *clientID)
	}
	proofHeight := heights.ConsensusStateHeights[0]

	consRes, err := hub.ConsensusState(ctx, &clienttypes.QueryConsensusStateRequest{
		ClientId:       *clientID,
		RevisionNumber: proofHeight.RevisionNumber,
		RevisionHeight: proofHeight.RevisionHeight,
	})
	must(err)
	consensusState := &ibctm.ConsensusState{}
	must(proto.Unmarshal(consRes.ConsensusState.Value, consensusState))
	step("Hub consensus state of seda-1 at height %s: root %X (%s)",
		proofHeight, consensusState.Root.Hash, consensusState.Timestamp.UTC().Format(time.RFC3339))

	// 2. Key of the data result in SEDA's x/batching store.
	drBlockHeight, err := lookupDRBlockHeight(ctx, *sedaREST, *drID)
	must(err)
	step("Data request %s submitted at SEDA height %d", *drID, drBlockHeight)

	// 3. Proof from SEDA. A proof queried at height H verifies against the app hash
	// committed in the header of block H+1, which is what the Hub stores at H+1.
	seda, err := rpchttp.New(*sedaRPC, "/websocket")
	must(err)
	queryHeight := int64(proofHeight.RevisionHeight) - 1

	// A data result is stored under batched=false, then moved to batched=true once
	// it is included in a batch: find the key that exists at queryHeight.
	var (
		batched bool
		key     []byte
		value   []byte
		proofBz []byte
	)
	for _, b := range []bool{true, false} {
		k := dataResultKey(b, *drID, drBlockHeight)
		res, err := seda.ABCIQueryWithOptions(ctx, "/store/"+sedaStoreName+"/key", k,
			rpcclient.ABCIQueryOptions{Height: queryHeight, Prove: true})
		must(err)
		if !res.Response.IsOK() {
			log.Fatalf("abci_query failed: %s", res.Response.Log)
		}
		if len(res.Response.Value) == 0 {
			continue
		}
		merkleProof, err := commitmenttypes.ConvertProofs(res.Response.ProofOps)
		must(err)
		proofBz, err = merkleProof.Marshal()
		must(err)
		batched, key, value = b, k, res.Response.Value
		break
	}
	if value == nil {
		log.Fatalf("data result not found in SEDA state at height %d", queryHeight)
	}
	step("SEDA key at height %d (batched=%t): %X", queryHeight, batched, key)
	printDataResult(value)

	// 4. What the Hub's 07-tendermint client runs for VerifyMembership.
	path := commitmenttypesv2.NewMerklePath([]byte(sedaStoreName), key)
	verify := func(path commitmenttypesv2.MerklePath, value []byte) error {
		var merkleProof commitmenttypes.MerkleProof
		if err := merkleProof.Unmarshal(proofBz); err != nil {
			return err
		}
		return merkleProof.VerifyMembership(clientState.ProofSpecs, consensusState.GetRoot(), path, value)
	}

	if err := verify(path, value); err != nil {
		fmt.Printf("\n❌ VerifyMembership failed: %v\n", err)
		os.Exit(1)
	}
	fmt.Printf("\n✅ VerifyMembership succeeded: the Hub's light client of seda-1 proves this data result.\n\n")

	// Negative checks: they must fail, otherwise the demo proves nothing.
	tampered := append(append([]byte{}, value...), 0x00)
	expectFailure("tampered value", verify(path, tampered))
	otherKey := dataResultKey(!batched, *drID, drBlockHeight)
	expectFailure(fmt.Sprintf("key with batched=%t", !batched), verify(commitmenttypesv2.NewMerklePath([]byte(sedaStoreName), otherKey), value))
}

// dataResultKey builds the x/batching key of a data result by hand, as a CosmWasm
// contract would, and checks it against the collections encoding SEDA uses:
//
//	prefix(0x00) | batched (1 byte) | dr_id + 0x00 | dr_block_height (8 bytes BE)
func dataResultKey(batched bool, drID string, drBlockHeight uint64) []byte {
	key := []byte{sedaDataResultsPrefix}
	if batched {
		key = append(key, 0x01)
	} else {
		key = append(key, 0x00)
	}
	key = append(key, drID...)
	key = append(key, 0x00) // non-terminal string keys are null-terminated
	key = binary.BigEndian.AppendUint64(key, drBlockHeight)

	kc := collections.TripleKeyCodec(collections.BoolKey, collections.StringKey, collections.Uint64Key)
	expected, err := collections.EncodeKeyWithPrefix([]byte{sedaDataResultsPrefix}, kc, collections.Join3(batched, drID, drBlockHeight))
	must(err)
	if hex.EncodeToString(key) != hex.EncodeToString(expected) {
		log.Fatalf("hand-built key %X differs from collections encoding %X", key, expected)
	}
	return key
}

func lookupDRBlockHeight(ctx context.Context, rest, drID string) (uint64, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rest+"/seda-chain/batching/data_result/"+drID, nil)
	if err != nil {
		return 0, err
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return 0, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return 0, fmt.Errorf("data result lookup: HTTP %d", res.StatusCode)
	}
	var body struct {
		DataResult struct {
			DrBlockHeight uint64 `json:"dr_block_height,string"`
		} `json:"data_result"`
	}
	if err := json.NewDecoder(res.Body).Decode(&body); err != nil {
		return 0, err
	}
	return body.DataResult.DrBlockHeight, nil
}

// printDataResult decodes the proven value (sedachain.batching.v1.DataResult)
// with plain protowire, the way a contract would without SEDA's Go types.
func printDataResult(value []byte) {
	fields := map[protowire.Number]string{
		1: "id", 2: "dr_id", 3: "dr_block_height", 4: "version", 5: "block_height",
		6: "block_timestamp", 7: "exit_code", 9: "result", 12: "consensus",
	}
	fmt.Println("   Proven DataResult:")
	for len(value) > 0 {
		num, typ, n := protowire.ConsumeTag(value)
		must(protowire.ParseError(n))
		value = value[n:]
		name := fields[num]
		switch typ {
		case protowire.VarintType:
			v, n := protowire.ConsumeVarint(value)
			must(protowire.ParseError(n))
			value = value[n:]
			if name != "" {
				fmt.Printf("     %-16s %d\n", name, v)
			}
		case protowire.BytesType:
			v, n := protowire.ConsumeBytes(value)
			must(protowire.ParseError(n))
			value = value[n:]
			if name != "" {
				fmt.Printf("     %-16s %q\n", name, v)
			}
		default:
			n := protowire.ConsumeFieldValue(num, typ, value)
			must(protowire.ParseError(n))
			value = value[n:]
		}
	}
}

func expectFailure(what string, err error) {
	if err == nil {
		fmt.Printf("❌ %s was accepted: the check is not meaningful\n", what)
		os.Exit(1)
	}
	fmt.Printf("✅ %s rejected as expected\n", what)
}

func step(format string, args ...any) {
	fmt.Printf("→ "+format+"\n", args...)
}

func must(err error) {
	if err != nil {
		log.Fatal(err)
	}
}
