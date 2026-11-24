# Skillsmith `compile_and_run` response format

The browser host implements this format in `packages/experimental/webworker-runtime/src/x6/wasm-cells.ts`.

1. The host writes the request into linear memory and calls `mv_run(pointer, request.byteLength)`.
2. The returned `i64` packs the response length into the high 32 bits and its byte offset into the low 32 bits. The offset must be at least 64. The length must be positive and at most `CELL_MAX_RESPONSE_BYTES`, and the range must fit in the module’s memory. An invalid range yields `RESPONSE_DESCRIPTOR`.
3. The host decodes that byte range as UTF-8 and parses JSON. For a successful compiled guest response, the value must be a non-array object with `abi: 1`, `status: "ok"` and its own `result` property. The guest may omit `seq` or supply a safe integer. Pinned cells must echo the request sequence on success.
4. A response with `status: "refused"` returns its string `code`, or `REFUSED` if the code is absent or has another type. Unparseable JSON or an invalid success response yields `MALFORMED_RESPONSE`. For a compiled guest the diagnostic includes `expected` and `got`.
