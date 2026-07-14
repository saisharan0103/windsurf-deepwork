import test from "node:test";
import assert from "node:assert/strict";
import { decodeStdinBuffer } from "../src/cli.js";

const payload = '{"agent_action_name":"pre_read_code"}';

test("hook stdin decoder accepts plain UTF-8", () => {
  assert.equal(decodeStdinBuffer(Buffer.from(payload, "utf8")), payload);
});

test("hook stdin decoder strips a UTF-8 BOM", () => {
  const encoded = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(payload, "utf8")]);
  assert.equal(decodeStdinBuffer(encoded), payload);
});

test("hook stdin decoder accepts UTF-16LE with a BOM", () => {
  const encoded = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(payload, "utf16le")]);
  assert.equal(decodeStdinBuffer(encoded), payload);
});

test("hook stdin decoder detects BOM-less UTF-16LE from Windows PowerShell", () => {
  assert.equal(decodeStdinBuffer(Buffer.from(payload, "utf16le")), payload);
});

test("hook stdin decoder accepts UTF-16BE with a BOM", () => {
  const littleEndian = Buffer.from(payload, "utf16le");
  const bigEndian = Buffer.allocUnsafe(littleEndian.length + 2);
  bigEndian[0] = 0xfe;
  bigEndian[1] = 0xff;
  for (let index = 0; index < littleEndian.length; index += 2) {
    bigEndian[index + 2] = littleEndian[index + 1];
    bigEndian[index + 3] = littleEndian[index];
  }
  assert.equal(decodeStdinBuffer(bigEndian), payload);
});
