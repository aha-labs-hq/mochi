import { constants, createHash, generateKeyPairSync, privateEncrypt, sign } from "node:crypto";
import { createRequire } from "node:module";
import { describe, expect, test } from "bun:test";

const require = createRequire(import.meta.url);
const forge = require("node-forge") as {
  pki: {
    publicKeyFromPem(pem: string): {
      verify(digest: string, signature: string): boolean;
    };
  };
};

function derSequence(...parts: Buffer[]): Buffer {
  const value = Buffer.concat(parts);
  if (value.length >= 128) throw new Error("test DER helper only supports short lengths");
  return Buffer.concat([Buffer.from([0x30, value.length]), value]);
}

function derOctetString(value: Buffer): Buffer {
  if (value.length >= 128) throw new Error("test DER helper only supports short lengths");
  return Buffer.concat([Buffer.from([0x04, value.length]), value]);
}

describe("node-forge RSA verification pin", () => {
  test("rejects extra nested DigestAlgorithm elements while accepting a valid signature", () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicExponent: 65_537,
      privateKeyEncoding: { type: "pkcs1", format: "pem" },
      publicKeyEncoding: { type: "pkcs1", format: "pem" },
    });
    const message = Buffer.from("node-forge nested DigestAlgorithm regression");
    const digest = createHash("sha256").update(message).digest();
    const forgeKey = forge.pki.publicKeyFromPem(publicKey);
    const digestForForge = digest.toString("binary");

    const validSignature = sign("sha256", message, {
      key: privateKey,
      padding: constants.RSA_PKCS1_PADDING,
    });
    expect(forgeKey.verify(digestForForge, validSignature.toString("binary"))).toBeTrue();

    const algorithmIdentifier = derSequence(
      Buffer.from("0609608648016503040201", "hex"),
      Buffer.from("0500", "hex"),
      Buffer.from("0500", "hex"),
    );
    const digestInfo = derSequence(algorithmIdentifier, derOctetString(digest));
    const modulusBytes = 2048 / 8;
    const paddingBytes = modulusBytes - 3 - digestInfo.length;
    if (paddingBytes < 8) throw new Error("test key is too small for PKCS#1 padding");
    const encodedMessage = Buffer.concat([
      Buffer.from([0x00, 0x01]),
      Buffer.alloc(paddingBytes, 0xff),
      Buffer.from([0x00]),
      digestInfo,
    ]);
    const malformedSignature = privateEncrypt(
      { key: privateKey, padding: constants.RSA_NO_PADDING },
      encodedMessage,
    );

    let accepted = false;
    try {
      accepted = forgeKey.verify(digestForForge, malformedSignature.toString("binary"));
    } catch {
      // Rejecting malformed DigestInfo by throwing is the expected path.
    }
    expect(accepted).toBeFalse();
  });
});
