/**
 * Return the number of trailing bytes in `buf` that form an incomplete
 * UTF-8 sequence.  For example, if the buffer ends with 0xE2 (the start
 * of a 3-byte sequence), this returns 1 so those bytes can be saved and
 * prepended to the next chunk.
 *
 * Strategy: look at the last 1-4 bytes and decode backwards to find
 * whether the tail contains a complete final character or is cut off.
 */
export function countTrailingIncompleteUtf8Bytes(buf: Buffer): number {
  if (buf.length === 0) return 0;

  // Read up to 4 bytes from the end.
  const n = Math.min(buf.length, 4);
  const bytes: number[] = [];
  for (let i = 0; i < n; i++) bytes.push(buf[buf.length - n + i]!);

  // Walk backwards to find the lead byte of the final character.
  // Continuation bytes are 10xxxxxx (0x80-0xBF).
  let leadIdx = n - 1;
  while (leadIdx > 0 && (bytes[leadIdx]! & 0xc0) === 0x80) {
    leadIdx--;
  }
  const lead = bytes[leadIdx]!;
  const contCount = n - 1 - leadIdx; // continuation bytes after the lead

  // ASCII byte at the end → complete.
  if ((lead & 0x80) === 0) return 0;

  // Lone continuation byte (no lead byte in range) → all n bytes are orphaned.
  if ((lead & 0xc0) === 0x80) return n;

  // Determine how many continuation bytes this lead expects.
  let expected: number;
  if ((lead & 0xe0) === 0xc0) expected = 1;
  else if ((lead & 0xf0) === 0xe0) expected = 2;
  else if ((lead & 0xf8) === 0xf0) expected = 3;
  else return 0; // invalid lead (11111xxx)

  if (contCount >= expected) return 0; // complete sequence
  // Incomplete: return total bytes from lead through last byte.
  return n - leadIdx;
}
