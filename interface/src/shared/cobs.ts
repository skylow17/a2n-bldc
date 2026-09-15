/**
 * COBS — Consistent Overhead Byte Stuffing.
 *
 * Jumeau de `controller-2/Core/Src/comm/cobs.c`, y compris sur le cas limite du groupe plein
 * qui tombe exactement en fin de données : aucun octet de code supplémentaire n'est émis.
 * Les deux formes se décodent identiquement, mais les deux implémentations doivent produire
 * les mêmes octets — sinon la divergence se révèle le jour où une trame fait pile 254 octets
 * sans zéro. Les vecteurs partagés (`docs/protocol-vectors.json`) verrouillent ce point.
 */

/** Taille encodée maximale pour `n` octets bruts, délimiteur non compris. */
export function cobsMaxEncoded(n: number): number {
  return n + Math.floor(n / 254) + 1;
}

/** Encode sans écrire le délimiteur final : c'est l'appelant qui l'ajoute. */
export function cobsEncode(src: Uint8Array): Uint8Array {
  // +1 : le code final peut tomber hors de la longueur rendue (groupe plein en fin).
  const dst = new Uint8Array(cobsMaxEncoded(src.length) + 1);

  let out = 1; // la place du premier octet de code est réservée d'emblée
  let codePos = 0;
  let code = 1;

  for (let i = 0; i < src.length; i++) {
    const b = src[i]!;
    if (b !== 0) {
      dst[out++] = b;
      code++;
    }
    if (b === 0 || code === 0xff) {
      dst[codePos] = code;
      code = 1;
      codePos = out;
      if (b === 0 || i + 1 < src.length) {
        out++;
      }
    }
  }

  dst[codePos] = code;
  return dst.subarray(0, out);
}

/**
 * Décode une trame, délimiteur exclu. `src` ne doit contenir aucun 0x00.
 * Rend `null` si l'entrée est malformée — jamais une trame partielle : une trame douteuse
 * se jette, elle ne se répare pas.
 */
export function cobsDecode(src: Uint8Array): Uint8Array | null {
  if (src.length === 0) return null;

  const out: number[] = [];
  let i = 0;

  while (i < src.length) {
    const code = src[i]!;
    // 0x00 est le délimiteur : il ne doit jamais parvenir ici.
    if (code === 0) return null;
    // Le groupe annonce code-1 octets littéraux : ils doivent tenir dans l'entrée.
    if (i + code > src.length) return null;
    i++;

    for (let k = 1; k < code; k++) {
      out.push(src[i++]!);
    }

    // Zéro implicite en fin de groupe, sauf groupe plein et sauf en toute fin d'entrée.
    if (code !== 0xff && i < src.length) {
      out.push(0);
    }
  }

  return Uint8Array.from(out);
}
