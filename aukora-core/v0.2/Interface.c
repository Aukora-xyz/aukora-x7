#include <lean/lean.h>
#include <string.h>
#include "exports.h"

lean_object *r9_context(void);
static bool initialize_runtime(void) { return r9_context() != NULL; }

static bool started, invalid_frame, invalid_candidate;
static lean_object *current;
static uint8_t frame[1024 * 1024 + 2 * 65535 + 128];
static uint32_t length;

uint32_t input(uint32_t byte) {
    if (byte > 255 || length == sizeof(frame)) invalid_frame = true;
    if (invalid_frame) return 0;
    frame[length++] = (uint8_t)byte;
    return 1;
}

static lean_object *take_bytes(void) {
    uint32_t size = length;
    bool ok = !invalid_frame;
    length = 0;
    invalid_frame = false;
    if (!ok) return NULL;
    if (!started) started = initialize_runtime();
    if (!started) return NULL;
    lean_object *bytes = lean_alloc_sarray(1, size, size);
    memcpy(lean_sarray_cptr(bytes), frame, size);
    return bytes;
}

static uint32_t accept(lean_object *result) {
    if (lean_is_scalar(result)) return 0;
    lean_object *next = lean_ctor_get(result, 0);
    lean_inc(next);
    lean_dec(result);
    if (current) lean_dec(current);
    current = next;
    return 1;
}

/* The public state holds its law identity from genesis through the next accepted install. */
static uint8_t active_law[32];
static bool has_law_identity;

static void refresh_law(void) {
    lean_object *context = r9_context();
    lean_inc(context);
    lean_inc(current);
    lean_object *digest = r11_law_digest(context, current);
    has_law_identity = lean_sarray_size(digest) == sizeof(active_law);
    if (has_law_identity)
        memcpy(active_law, lean_sarray_cptr(digest), sizeof(active_law));
    lean_dec(digest);
}

uint32_t init(void) {
    lean_object *keys = take_bytes();
    if (!keys) return 0;
    if (current) { lean_dec(keys); return 0; }
    uint32_t verdict = accept(r9_genesis(keys));
    if (verdict) refresh_law();
    return verdict;
}

uint32_t reset(void) {
    length = 0;
    invalid_frame = invalid_candidate = false;
    if (!current) return 0;
    current = r9_reset(current);
    return 1;
}

uint32_t feed(void) {
    lean_object *chunk = take_bytes();
    if (!chunk) {
        if (current) invalid_candidate = true;
        return 0;
    }
    if (!current || invalid_candidate) { lean_dec(chunk); return 0; }
    current = r9_feed(chunk, current);
    return 1;
}

uint32_t step(void) {
    lean_object *wire = take_bytes();
    if (!wire) return 0;
    if (!current) { lean_dec(wire); return 0; }
    bool install = lean_sarray_size(wire) && lean_sarray_cptr(wire)[0] == 27;
    if (invalid_candidate && install) {
        lean_dec(wire);
        return 0;
    }
    lean_object *context = r9_context();
    lean_inc(context);
    lean_inc(current);
#ifdef RELEASE_RATCHET
    uint32_t verdict = accept(r11_ratchet_step(context, wire, current));
#else
    uint32_t verdict = accept(r11_step(context, wire, current));
#endif
    if (verdict && install) refresh_law();
    return verdict;
}

uint32_t verify(void) {
    lean_object *packed = take_bytes();
    return packed ? r5_verify_packed(packed) : 0;
}

uint32_t head(uint32_t index) {
    if (!current || index >= 32) return 256;
    lean_inc(current);
    return lean_unbox(r9_head_byte(current, index));
}

uint32_t core(uint32_t index) {
    if (!current || index >= 32) return 256;
    lean_inc(current);
    return lean_unbox(r9_core_byte(current, index));
}

uint32_t threshold(void) {
    if (!current) return 256;
    lean_inc(current);
    return lean_unbox(r9_threshold(current));
}

uint32_t recordByte(uint32_t entry, uint32_t offset) {
    if (!current) return 256;
    lean_inc(current);
    return lean_unbox(r9_record_byte(current, entry, offset));
}

uint32_t stamp(void) {
    lean_object *wire = take_bytes();
    if (!wire) return 0;
    if (!current) { lean_dec(wire); return 0; }
    lean_inc(current);
    return accept(r9_stamp(wire, current));
}

uint32_t stampCount(void) {
    if (!current) return 0;
    lean_inc(current);
    return lean_unbox(r9_stamp_count(current));
}

uint32_t stampByte(uint32_t entry, uint32_t offset) {
    if (!current) return 256;
    lean_inc(current);
    return lean_unbox(r9_stamp_byte(current, entry, offset));
}

uint32_t hashHead(void) {
    lean_object *packed = take_bytes();
    return packed ? lean_unbox(r8_hash_head(packed)) : 256;
}

uint32_t outcome(void) {
    lean_object *digest = take_bytes();
    if (!digest) return 256;
    if (!current) { lean_dec(digest); return 256; }
    lean_inc(current);
    return lean_unbox(r9_outcome(current, digest));
}

uint32_t halted(void) {
    if (!current) return 256;
    lean_inc(current);
    return r11_halted(current);
}

uint32_t guessCeiling(void) {
    if (!current) return 256;
    lean_inc(current);
    return r11_ceiling(current);
}

uint32_t lawByte(uint32_t index) {
    return has_law_identity && index < sizeof(active_law) ? active_law[index] : 256;
}

uint32_t installReason(void) {
    lean_object *wire = take_bytes();
    if (!wire) return 256;
    if (!current) { lean_dec(wire); return 256; }
    lean_object *context = r9_context();
    lean_inc(context);
    lean_inc(current);
    return lean_unbox(r11_reason(context, wire, current));
}
