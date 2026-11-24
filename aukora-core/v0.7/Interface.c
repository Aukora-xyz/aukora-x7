#include <lean/lean.h>
#include <string.h>
#include "exports.h"

#ifdef RELEASE_LITE
void __wasm_call_ctors(void);
static bool initialize_runtime(void) {
    __wasm_call_ctors();
    r6_constants();
    return true;
}
#else
lean_object *r9_context(void);
static bool initialize_runtime(void) { return r9_context() != NULL; }
#endif

static bool started, invalid_frame;
enum { STAGING_CAP = 16 * 1024 * 1024, RECORD_BYTE_CAP = 2 * 1024 * 1024, RECORD_ENTRY_CAP = 512, RECOVERY_SLOTS = 16 };
static uint32_t staged_size, record_bytes, record_entries;
static uint32_t recovery_used;
static lean_object *current, *journal, *sealed_head;

static uint8_t frame[1024 * 1024 + 2 * 65535 + 128];
static uint32_t length;
#ifndef RELEASE_LITE
#include "tools/JudgePin.h"
#else
#include "root-law.h"
static int judge_cache;
#endif

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
#ifndef RELEASE_LITE
    lean_object *context = r9_context();
    lean_inc(context);
    lean_inc(current);
    lean_object *digest = r11_law_digest(context, current);
    has_law_identity = lean_sarray_size(digest) == sizeof(active_law);
    if (has_law_identity)
        memcpy(active_law, lean_sarray_cptr(digest), sizeof(active_law));
    lean_dec(digest);
#else
    memcpy(active_law, initial_law, sizeof(active_law));
    has_law_identity = true;
#endif
}

static lean_object *law_bytes(void) {
    lean_object *copy = lean_alloc_sarray(1, sizeof(active_law), sizeof(active_law));
    memcpy(lean_sarray_cptr(copy), active_law, sizeof(active_law));
    return copy;
}

uint32_t init(void) {
    lean_object *keys = take_bytes();
    if (!keys) return 0;
    if (current) { lean_dec(keys); return 0; }
    uint32_t verdict = accept(r9_genesis(keys));
    if (verdict) {
        refresh_law();
        lean_inc(current);
        journal = r12b_first(law_bytes(), current);
    }
    return verdict;
}

/* Round 12c D: a bound genesis. Input is the 1,984 key bytes followed by the 32-byte host
 * value. The law digest is the one an ordinary genesis would hold. The record identifier is
 * SHA-256 of "AUKORA/R12C/record", law, keys and host value, and becomes the first head.
 * It is kept here for the life of the instance: key changes, seals and continuations move
 * the head but never this value. */
static uint8_t record_id[32];
static bool has_record_id;

uint32_t initBound(void) {
    lean_object *bytes = take_bytes();
    if (!bytes) return 0;
    if (current || lean_sarray_size(bytes) != 1984 + 32) { lean_dec(bytes); return 0; }
    lean_object *keys = lean_alloc_sarray(1, 1984, 1984);
    memcpy(lean_sarray_cptr(keys), lean_sarray_cptr(bytes), 1984);
    lean_object *host = lean_alloc_sarray(1, 32, 32);
    memcpy(lean_sarray_cptr(host), lean_sarray_cptr(bytes) + 1984, 32);
    lean_dec(bytes);
    lean_inc(keys);
    if (!accept(r9_genesis(keys))) { lean_dec(keys); lean_dec(host); return 0; }
    refresh_law();
    lean_dec(current);
    current = NULL;
    if (!has_law_identity) { lean_dec(keys); lean_dec(host); return 0; }
    if (!accept(r12c_bound_genesis(law_bytes(), keys, host))) return 0;
    for (uint32_t i = 0; i < 32; i++) {
        lean_inc(current);
        record_id[i] = (uint8_t)lean_unbox(r9_head_byte(current, i));
    }
    has_record_id = true;
    lean_inc(current);
    journal = r12b_first(law_bytes(), current);
    return 1;
}

uint32_t recordIdByte(uint32_t index) {
    return has_record_id && index < sizeof(record_id) ? record_id[index] : 256;
}

uint32_t reset(void) {
    length = 0;
    invalid_frame = false;
    if (!current || sealed_head) return 0;
    judge_cache = -1;
    staged_size = 0;
    current = r9_reset(current);
    return 1;
}

uint32_t feed(void) {
    if (!current || sealed_head || invalid_frame || length > STAGING_CAP - staged_size) {
        length = 0;
        invalid_frame = false;
        return 0;
    }
    lean_object *chunk = take_bytes();
    if (!chunk) return 0;
    staged_size += lean_sarray_size(chunk);
    judge_cache = -1;
    current = r9_feed(chunk, current);
    return 1;
}

/* Count raw frames and sidecars against the ordinary budget. Additional
 * capacity belongs to accepted owner recovery operations and a separate trailer. */
static bool ordinary_room(uint32_t size) {
    return record_entries < RECORD_ENTRY_CAP && size <= RECORD_BYTE_CAP - record_bytes;
}

static bool entry_input(bool allow_recovery) {
    if (current && !sealed_head && !invalid_frame) {
        if (ordinary_room(length)) return true;
        if (allow_recovery && recovery_used < RECOVERY_SLOTS && length > 0 &&
            (frame[0] == 20 || (length >= 3 && frame[0] == 255 && frame[1] == 2 &&
                                (frame[2] == 51 || frame[2] == 53)))) return true;
    }
    length = 0;
    invalid_frame = false;
    return false;
}

static void committed(lean_object *wire, uint8_t kind, bool ordinary) {
    uint32_t size = lean_sarray_size(wire);
    if (ordinary) {
        record_entries++;
        record_bytes += size;
    } else {
        recovery_used++;
    }
    journal = r12b_entry(journal, kind, wire);
}

uint32_t step(void) {
    if (!entry_input(true)) return 0;
    lean_object *wire = take_bytes();
    if (!wire) return 0;
    bool ordinary = ordinary_room(lean_sarray_size(wire));
    if (!ordinary) {
        lean_inc(wire);
        if (!r12b_recovery_kind(wire)) { lean_dec(wire); return 0; }
    }
    bool install = lean_sarray_size(wire) && lean_sarray_cptr(wire)[0] == 27;
#ifndef RELEASE_LITE
    if (install && !staged_judge_matches()) { lean_dec(wire); return 0; }
#endif
    lean_inc(wire);
    lean_inc(current);
#ifdef RELEASE_LITE
    uint32_t verdict = accept(r12_lite_step(wire, current));
#else
    lean_object *context = r9_context();
    lean_inc(context);
    uint32_t verdict = accept(r11_step(context, wire, current));
#endif
    if (!verdict) { lean_dec(wire); return 0; }
    committed(wire, 0, ordinary);
    if (install) {
        staged_size = 0;
        judge_cache = -1;
        refresh_law();
    }
    return 1;
}

uint32_t journalByte(uint32_t index) {
    return journal && index < lean_sarray_size(journal) ? lean_sarray_cptr(journal)[index] : 256;
}

uint32_t sealByte(uint32_t index) {
    return sealed_head && index < lean_sarray_size(sealed_head) ? lean_sarray_cptr(sealed_head)[index] : 256;
}

uint32_t seal(void) {
    lean_object *wire = take_bytes();
    if (!wire) return 0;
    if (!current || !has_law_identity || sealed_head) { lean_dec(wire); return 0; }
    lean_inc(journal);
    lean_inc(current);
    lean_object *result = r12b_seal(journal, law_bytes(), wire, current);
    if (lean_is_scalar(result)) return 0;
    sealed_head = lean_ctor_get(result, 0);
    lean_inc(sealed_head);
    lean_dec(result);
    return 1;
}

uint32_t continueRecord(void) {
    lean_object *packed = take_bytes();
    if (!packed) return 0;
    if (!sealed_head) { lean_dec(packed); return 0; }
    lean_inc(sealed_head);
    lean_inc(current);
    lean_inc(packed);
    uint32_t verdict = accept(r12b_continue(sealed_head, law_bytes(), packed, current));
    if (!verdict) { lean_dec(packed); return 0; }
    lean_dec(sealed_head);
    sealed_head = NULL;
    lean_dec(journal);
    journal = r12_digest(packed);
    record_entries = record_bytes = recovery_used = 0;
    return 1;
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
    if (!entry_input(false)) return 0;
    lean_object *wire = take_bytes();
    if (!wire) return 0;
    lean_inc(wire);
    lean_inc(current);
    uint32_t verdict = accept(r9_stamp(wire, current));
    if (verdict) committed(wire, 1, true);
    else lean_dec(wire);
    return verdict;
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
#ifdef RELEASE_LITE
    uint32_t reason = lean_sarray_size(wire) && lean_sarray_cptr(wire)[0] == 27 ? 12 : 0;
    lean_dec(wire);
    return reason;
#else
    if (lean_sarray_size(wire) && lean_sarray_cptr(wire)[0] == 27 &&
        !staged_judge_matches()) { lean_dec(wire); return 11; }
    lean_object *context = r9_context();
    lean_inc(context);
    lean_inc(current);
    return lean_unbox(r11_reason(context, wire, current));
#endif
}

uint32_t witnessMask(void) {
    lean_object *wire = take_bytes();
    if (!wire) return 256;
#ifndef RELEASE_LITE
    if (current && staged_judge_matches()) {
        lean_object *context = r9_context();
        lean_inc(context);
        lean_inc(current);
        return lean_unbox(r12_witness_mask(context, wire, current));
    }
#endif
    lean_dec(wire);
    return 256;
}
