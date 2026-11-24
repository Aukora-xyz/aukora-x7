/*
 * The outgoing executable fixes a prefix of the staged file. Its linker pin
 * covers the full stripped module, including the executed code and actual
 * initialized data. Only well-framed custom sections may follow that prefix.
 * pin[0..39] is normalized to zero when computing its non-circular SHA-256.
 */
static const volatile struct {
    uint8_t marker[24], pin[40], end_marker[8];
} judge_descriptor = {"AUKORA/R12/executable", {0}, "JUDGE12"};

static uint32_t judge_word(const volatile uint8_t *p) {
    return p[0] | (uint32_t)p[1]<<8 | (uint32_t)p[2]<<16 | (uint32_t)p[3]<<24;
}

static bool judge_varuint(const uint8_t *bytes, size_t n, size_t *pos, uint32_t *result) {
    uint32_t value = 0;
    for (unsigned i = 0; i < 5 && *pos < n; ++i) {
        uint8_t b = bytes[(*pos)++];
        if (i == 4 && (b & 0xf0)) return false;
        value |= (uint32_t)(b & 127) << (7*i);
        if (!(b & 128)) { *result = value; return true; }
    }
    return false;
}

static bool matches_judge(lean_object *staged) {
    const uint8_t *bytes = lean_sarray_cptr(staged);
    size_t count = lean_sarray_size(staged);
    const volatile uint8_t *pin = judge_descriptor.pin;
    uint32_t size = judge_word(pin), at = judge_word(pin + 4);
    if (size < sizeof(judge_descriptor) || count < size || at > size - 40) return false;
    for (unsigned i = 0; i < 40; ++i)
        if (bytes[at+i] != pin[i]) return false;
    for (size_t pos = size; pos < count;) {
        uint32_t len, name_len;
        if (bytes[pos++] != 0 || !judge_varuint(bytes, count, &pos, &len) || len > count-pos)
            return false;
        size_t stop = pos + len;
        if (!judge_varuint(bytes, stop, &pos, &name_len) || name_len > stop-pos)
            return false;
        pos = stop;
    }
    lean_object *image = lean_alloc_sarray(1, size, size);
    uint8_t *copy = lean_sarray_cptr(image);
    memcpy(copy, bytes, size);
    memset(copy + at, 0, 40);
    lean_object *actual = r12_digest(image);
    bool ok = lean_sarray_size(actual) == 32;
    for (unsigned i = 0; ok && i < 32; ++i)
        ok = lean_sarray_cptr(actual)[i] == pin[8+i];
    lean_dec(actual);
    return ok;
}

/* Staging changes only on feed or reset. */
static int judge_cache = -1;
static bool staged_judge_matches(void) {
    if (judge_cache < 0) {
        lean_inc(current);
        lean_object *file = r12_staged(current);
        judge_cache = matches_judge(file) ? 1 : 0;
        lean_dec(file);
    }
    return judge_cache == 1;
}
