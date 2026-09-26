#!/usr/bin/env python3
"""Genere docs/protocol-vectors.json : les octets de reference du protocole.

Pourquoi un tiers en Python plutot que de faire produire les vecteurs par l'une des deux
implementations : si le C generait les vecteurs que verifie le TypeScript, on ne testerait
que l'accord du TypeScript avec le C, et une erreur commune de lecture de la specification
passerait inapercue des deux cotes. Ce fichier est donc une troisieme lecture, independante,
ancree sur des references publiees :

  - COBS : les vecteurs de l'article de Cheshire & Baker (1999), y compris les cas limites
    a 254 et 255 octets ou les implementations divergent le plus souvent ;
  - CRC-16/CCITT-FALSE : le vecteur d'arbitrage CRC16("123456789") == 0x29B1 ;
  - CRC-32/ISO-HDLC : CRC32("123456789") == 0xCBF43926.

Le JSON produit est commite. Ce script ne tourne que lorsque la specification change.

    python tools/gen_protocol_vectors.py

Il ecrit aussi controller-2/Core/Inc/comm/selftest_vectors.h, la meme table en C, que la
commande console SELFTEST execute sur la cible.
"""
import io
import json
import os
import struct

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
JSON_OUT = os.path.join(HERE, "docs", "protocol-vectors.json")
H_OUT = os.path.join(HERE, "controller-2", "Core", "Inc", "comm", "selftest_vectors.h")


# ----------------------------------------------------------------- primitives de reference

def crc16(data, crc=0xFFFF):
    """CRC-16/CCITT-FALSE, bit a bit : la definition, sans table a verifier."""
    for byte in data:
        crc ^= byte << 8
        for _ in range(8):
            crc = ((crc << 1) ^ 0x1021) & 0xFFFF if crc & 0x8000 else (crc << 1) & 0xFFFF
    return crc


def crc32(data):
    """CRC-32/ISO-HDLC, bit a bit."""
    crc = 0xFFFFFFFF
    for byte in data:
        crc ^= byte
        for _ in range(8):
            crc = (crc >> 1) ^ 0xEDB88320 if crc & 1 else crc >> 1
    return crc ^ 0xFFFFFFFF


def cobs_encode(src):
    dst = bytearray(len(src) + len(src) // 254 + 2)
    out, code_pos, code = 1, 0, 1
    for i, b in enumerate(src):
        if b != 0:
            dst[out] = b
            out += 1
            code += 1
        if b == 0 or code == 0xFF:
            dst[code_pos] = code
            code, code_pos = 1, out
            if b == 0 or (i + 1) < len(src):
                out += 1
    dst[code_pos] = code
    return bytes(dst[:out])


def cobs_decode(src):
    if not src:
        return None
    out, i, n = bytearray(), 0, len(src)
    while i < n:
        code = src[i]
        if code == 0 or i + code > n:
            return None
        i += 1
        for _ in range(code - 1):
            out.append(src[i])
            i += 1
        if code != 0xFF and i < n:
            out.append(0)
    return bytes(out)


# Octet de debut du canal binaire (docs/protocol.md §1). C'est lui qui distingue une trame
# d'une ligne de console, et non le terminateur : COBS n'exclut que 0x00, pas 0x0A ni 0x0D.
FRAME_SOH = 0x01


def frame_encode(msg_id, flags, seq, payload):
    body = struct.pack("<HBB", msg_id, flags, seq) + payload
    raw = body + struct.pack("<H", crc16(body))
    return bytes([FRAME_SOH]) + cobs_encode(raw) + b"\x00"


# ----------------------------------------------------------------- dictionnaire M1b

# Miroir de controller-2/Core/Src/comm/param_table.c. Cette duplication est deliberee :
# c'est un vecteur de test fige. Un ajout de parametre cote firmware fait echouer le test,
# on regenere, et le hash change — ce qui est exactement la semantique voulue, puisqu'une
# recette enregistree se rattache a une forme de dictionnaire donnee.
PARAM_TABLE_M1B = [
    # id,     type, flags, name,              unit, group,   min,        max,          def
    (0x0001,  4, 0x01, "board.sysclk_hz",  "Hz", "Board", 0.0,      200000000.0, 0.0),
    (0x0002,  2, 0x01, "board.vref_mv",    "mV", "Board", 0.0,      65535.0,     0.0),
    (0x0010,  4, 0x01, "pwm.freq_hz",      "Hz", "PWM",   0.0,      100000.0,    0.0),
    (0x0011,  2, 0x01, "pwm.arr",          "",   "PWM",   0.0,      65535.0,     0.0),
    (0x0012,  6, 0x01, "pwm.deadtime_ns",  "ns", "PWM",   0.0,      10000.0,     0.0),
    (0x0013,  2, 0x01, "pwm.ccr4_trig",    "",   "PWM",   0.0,      65535.0,     0.0),
    # Parametres moteur, persistants (0x02), requires_disarm (0x04), calibrated (0x10) — 2026-09-26.
    (0x0200,  0, 0x16, "motor.pole_pairs", "",    "Motor", 0.0,      64.0,        0.0),
    (0x0201,  6, 0x16, "motor.r_ohm",      "ohm", "Motor", 0.0,      100.0,       0.0),
    (0x0202,  6, 0x16, "motor.l_h",        "H",   "Motor", 0.0,      0.1,         0.0),
    (0x0210,  6, 0x16, "enc.elec_offset_rad", "rad", "Motor", 0.0,   6.2832,      0.0),
    (0x0211,  1, 0x16, "enc.direction",    "",    "Motor", -1.0,     1.0,         0.0),
    (0x0220,  6, 0x16, "imot.scale_a",     "A/count", "Motor", 0.0,  0.02,        0.0),
    (0x0100,  4, 0x00, "dbg.echo_u32",     "",   "Debug", 0.0,      4294967040.0, 0.0),
    (0x0101,  3, 0x00, "dbg.echo_i16",     "",   "Debug", -32768.0, 32767.0,     0.0),
    (0x0102,  6, 0x00, "dbg.echo_f32",     "A",  "Debug", -1000.0,  1000.0,      0.0),
    (0x0103,  7, 0x00, "dbg.echo_bool",    "",   "Debug", 0.0,      1.0,         0.0),
    (0x0104,  8, 0x00, "dbg.echo_enum",    "",   "Debug", 0.0,      3.0,         0.0),
]

PARAM_NAME_LEN, PARAM_UNIT_LEN, PARAM_GROUP_LEN = 32, 8, 24


def f32(v):
    """Arrondi au f32 le plus proche, tel que le firmware le range et le serialise."""
    return struct.unpack("<f", struct.pack("<f", v))[0]


def fixed(text, width):
    raw = text.encode("ascii")
    assert len(raw) <= width, "%r depasse %d octets" % (text, width)
    return raw + bytes(width - len(raw))


def serialize_param(entry):
    pid, ptype, flags, name, unit, group, pmin, pmax, pdef = entry
    return (
        struct.pack("<HBB", pid, ptype, flags)
        + fixed(name, PARAM_NAME_LEN)
        + fixed(unit, PARAM_UNIT_LEN)
        + struct.pack("<fff", pmin, pmax, pdef)
        + fixed(group, PARAM_GROUP_LEN)
    )


# ----------------------------------------------------------------- jeux de vecteurs

def build():
    # COBS : vecteurs canoniques de l'article, plus les cas limites de groupe plein.
    cobs_cases = [
        b"\x00",
        b"\x00\x00",
        b"\x11\x22\x00\x33",
        b"\x11\x22\x33\x44",
        b"\x11\x00\x00\x00",
        bytes(range(1, 255)),          # 254 octets non nuls : groupe plein exact
        bytes(range(0, 255)),
        bytes(range(1, 256)),
        bytes(range(2, 256)) + b"\x00",
        bytes(range(3, 256)) + b"\x00\x01",
        b"\x01" * 253,
        b"\x01" * 254,
        b"\x01" * 255,
        bytes(512),                    # payload maximal entierement nul
    ]

    crc16_cases = [
        b"",
        b"\x00",
        b"123456789",
        b"\x01\x00\x00\x00",
        bytes(range(256)),
    ]

    crc32_cases = [b"", b"123456789", bytes(range(256))]

    # Trames completes, telles qu'elles circulent sur le lien.
    frame_cases = [
        ("HELLO", 0x0001, 0x00, 0x01, b""),
        ("PARAM_DICT_GET", 0x0010, 0x00, 0x02, struct.pack("<HH", 0, 6)),
        ("PARAM_READ 2 ids", 0x0012, 0x00, 0x7F, struct.pack("<HHH", 2, 0x0100, 0x0102)),
        ("PARAM_WRITE f32", 0x0013, 0x00, 0xFF, struct.pack("<H", 1) + struct.pack("<Hf", 0x0102, 1.5)),
        ("erreur RANGE", 0x0013, 0x03, 0x04, struct.pack("<H", 5)),
        ("payload 512 nuls", 0x0011, 0x01, 0x10, bytes(512)),
        # Un payload dont le corps contient des 0x00 en quantite : c'est la que COBS
        # travaille vraiment, et que le decoupage en groupes doit etre exact.
        ("payload alterne", 0x0011, 0x01, 0x11, bytes([0, 1] * 128)),
    ]

    doc = {
        "_comment": (
            "Vecteurs de reference du protocole A2N BLDC v2. Genere par "
            "tools/gen_protocol_vectors.py, verifie par les tests TypeScript "
            "(interface) et par la commande console SELFTEST (firmware). "
            "Ne pas editer a la main."
        ),
        "crc16": [
            {"input_hex": d.hex(), "crc": crc16(d)} for d in crc16_cases
        ],
        "crc32": [
            {"input_hex": d.hex(), "crc": crc32(d)} for d in crc32_cases
        ],
        "cobs": [
            {"raw_hex": d.hex(), "encoded_hex": cobs_encode(d).hex()} for d in cobs_cases
        ],
        "param_dict": {
            "_comment": (
                "Table du firmware a M1b, serialisee entree par entree, et le hash de "
                "forme attendu. Le firmware annonce le meme hash dans DEVICE_INFO et le "
                "rend lisible par la commande console PROTO?."
            ),
            "entry_wire_len": 80,
            "count": len(PARAM_TABLE_M1B),
            "hash": crc32(b"".join(serialize_param(e) for e in PARAM_TABLE_M1B)),
            "entries": [
                {
                    "id": e[0], "type": e[1], "flags": e[2], "name": e[3],
                    # Les bornes circulent en f32 : le vecteur donne la valeur que le fil porte
                    # reellement, pas le double Python qui l'a produite. 0.1 n'existe pas en f32.
                    "unit": e[4], "group": e[5], "min": f32(e[6]), "max": f32(e[7]), "def": f32(e[8]),
                    "wire_hex": serialize_param(e).hex(),
                }
                for e in PARAM_TABLE_M1B
            ],
        },
        "frames": [
            {
                "name": name,
                "msg_id": mid,
                "flags": fl,
                "seq": sq,
                "payload_hex": pl.hex(),
                "encoded_hex": frame_encode(mid, fl, sq, pl).hex(),
            }
            for (name, mid, fl, sq, pl) in frame_cases
        ],
    }

    # Garde-fous : les references publiees, et la reversibilite de chaque cas.
    assert crc16(b"123456789") == 0x29B1, "CRC-16/CCITT-FALSE incorrect"
    assert crc32(b"123456789") == 0xCBF43926, "CRC-32/ISO-HDLC incorrect"
    for d in cobs_cases:
        e = cobs_encode(d)
        assert 0 not in e, "un zero subsiste dans l'encode COBS"
        assert cobs_decode(e) == d, "aller-retour COBS casse"
    for e in PARAM_TABLE_M1B:
        assert len(serialize_param(e)) == 80, "entree de dictionnaire de taille inattendue"
    ids = [e[0] for e in PARAM_TABLE_M1B]
    assert len(ids) == len(set(ids)), "identifiant de parametre duplique"
    return doc


# ----------------------------------------------------------------- sortie C

def c_array(data):
    return ", ".join("0x%02X" % b for b in data)


def write_header(doc):
    lines = [
        "/**",
        " * @file selftest_vectors.h",
        " * @brief Vecteurs de reference du protocole, table generee.",
        " *",
        " * NE PAS EDITER : produit par tools/gen_protocol_vectors.py a partir de",
        " * docs/protocol-vectors.json. La commande console SELFTEST les execute sur la cible,",
        " * ce qui verifie le codec avec le vrai compilateur et la vraie endianness plutot que",
        " * sur une machine hote.",
        " */",
        "#ifndef COMM_SELFTEST_VECTORS_H",
        "#define COMM_SELFTEST_VECTORS_H",
        "",
        "#include <stddef.h>",
        "#include <stdint.h>",
        "",
        "typedef struct { const uint8_t *data; uint16_t len; uint16_t crc; } Crc16Vector_t;",
        "typedef struct { const uint8_t *raw; uint16_t raw_len;",
        "                 const uint8_t *enc; uint16_t enc_len; } CobsVector_t;",
        "",
    ]

    # CRC-16 : on ecarte les entrees vides, qui n'ont pas de tableau C legal.
    crc_used = [c for c in doc["crc16"] if c["input_hex"]]
    for i, c in enumerate(crc_used):
        data = bytes.fromhex(c["input_hex"])
        lines.append("static const uint8_t k_crc16_in%d[%d] = { %s };" % (i, len(data), c_array(data)))
    lines.append("")
    lines.append("static const Crc16Vector_t k_crc16_vectors[] = {")
    for i, c in enumerate(crc_used):
        data = bytes.fromhex(c["input_hex"])
        lines.append("  { k_crc16_in%d, %d, 0x%04XU }," % (i, len(data), c["crc"]))
    lines.append("};")
    lines.append("")

    for i, c in enumerate(doc["cobs"]):
        raw = bytes.fromhex(c["raw_hex"])
        enc = bytes.fromhex(c["encoded_hex"])
        lines.append("static const uint8_t k_cobs_raw%d[%d] = { %s };" % (i, len(raw), c_array(raw)))
        lines.append("static const uint8_t k_cobs_enc%d[%d] = { %s };" % (i, len(enc), c_array(enc)))
    lines.append("")
    lines.append("static const CobsVector_t k_cobs_vectors[] = {")
    for i, c in enumerate(doc["cobs"]):
        raw = bytes.fromhex(c["raw_hex"])
        enc = bytes.fromhex(c["encoded_hex"])
        lines.append("  { k_cobs_raw%d, %d, k_cobs_enc%d, %d }," % (i, len(raw), i, len(enc)))
    lines.append("};")
    lines.append("")
    lines.append("/* Forme attendue du dictionnaire, calculee par le generateur a partir de sa propre")
    lines.append(" * lecture de param_table.c. Si le firmware annonce un autre hash, c'est que la table")
    lines.append(" * a change sans que les vecteurs soient regeneres — ou que la serialisation derive. */")
    lines.append("#define SELFTEST_DICT_COUNT   %dU" % doc["param_dict"]["count"])
    lines.append("#define SELFTEST_DICT_HASH    0x%08XUL" % doc["param_dict"]["hash"])
    lines.append("")
    lines.append("#define SELFTEST_CRC16_COUNT  (sizeof(k_crc16_vectors) / sizeof(k_crc16_vectors[0]))")
    lines.append("#define SELFTEST_COBS_COUNT   (sizeof(k_cobs_vectors) / sizeof(k_cobs_vectors[0]))")
    lines.append("")
    lines.append("#endif /* COMM_SELFTEST_VECTORS_H */")

    io.open(H_OUT, "w", encoding="utf-8", newline="\n").write("\n".join(lines) + "\n")


def main():
    doc = build()
    io.open(JSON_OUT, "w", encoding="utf-8", newline="\n").write(
        json.dumps(doc, indent=2) + "\n"
    )
    write_header(doc)
    print("ecrit %s" % os.path.relpath(JSON_OUT, HERE))
    print("ecrit %s" % os.path.relpath(H_OUT, HERE))
    print("  crc16 : %d vecteurs" % len(doc["crc16"]))
    print("  crc32 : %d vecteurs" % len(doc["crc32"]))
    print("  cobs  : %d vecteurs" % len(doc["cobs"]))
    print("  trames: %d vecteurs" % len(doc["frames"]))
    print("  dict  : %d entrees, hash 0x%08X" % (doc["param_dict"]["count"], doc["param_dict"]["hash"]))


if __name__ == "__main__":
    main()
