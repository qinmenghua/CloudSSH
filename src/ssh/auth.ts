import { SSH_MSG_USERAUTH_REQUEST, SSH_MSG_USERAUTH_SUCCESS, SSH_MSG_USERAUTH_FAILURE, AuthResult } from '../types';
import { encodeString, concat, readUint32 } from './utils';

export class SSHAuth {
  static buildPasswordAuthRequest(
    username: string,
    password: string
  ): Uint8Array {
    const parts: Uint8Array[] = [
      new Uint8Array([SSH_MSG_USERAUTH_REQUEST]),
      encodeString(username),
      encodeString('ssh-connection'),
      encodeString('password'),
      new Uint8Array([0x00]),
      encodeString(password),
    ];

    return concat(...parts);
  }

  static async buildPublicKeyAuthRequest(
    username: string,
    privateKeyPEM: string,
    sessionID: Uint8Array
  ): Promise<Uint8Array> {
    const keyType = await this.detectKeyType(privateKeyPEM);
    if (keyType === 'ssh-rsa') {
      return this.buildRSAPublicKeyAuthRequest(username, privateKeyPEM, sessionID);
    }
    return this.buildEd25519PublicKeyAuthRequest(username, privateKeyPEM, sessionID);
  }

  private static async detectKeyType(pem: string): Promise<'ssh-ed25519' | 'ssh-rsa'> {
    const lines = pem.trim().split('\n');
    const b64 = lines.filter(l => !l.startsWith('-----')).join('');
    const raw = Uint8Array.from(atob(b64), c => c.charCodeAt(0));

    const magic = 'openssh-key-v1\0';
    const magicBytes = new TextEncoder().encode(magic);
    for (let i = 0; i < magicBytes.length; i++) {
      if (raw[i] !== magicBytes[i]) {
        if (pem.includes('RSA PRIVATE KEY')) return 'ssh-rsa';
        return 'ssh-ed25519';
      }
    }

    let offset = magicBytes.length;
    const cipherLen = readUint32(raw, offset); offset += 4;
    offset += cipherLen;
    const kdfLen = readUint32(raw, offset); offset += 4;
    offset += kdfLen;
    const kdfOptLen = readUint32(raw, offset); offset += 4;
    offset += kdfOptLen;
    offset += 4; // numKeys
    const pubSecLen = readUint32(raw, offset); offset += 4;
    offset += pubSecLen;
    const privSecLen = readUint32(raw, offset); offset += 4;
    const privSection = raw.slice(offset, offset + privSecLen);

    let po = 8;
    const ktLen = readUint32(privSection, po); po += 4;
    const keyType = new TextDecoder().decode(privSection.slice(po, po + ktLen));
    return keyType === 'ssh-rsa' ? 'ssh-rsa' : 'ssh-ed25519';
  }

  private static async buildEd25519PublicKeyAuthRequest(
    username: string,
    privateKeyPEM: string,
    sessionID: Uint8Array
  ): Promise<Uint8Array> {
    const { signingKey, publicKeyBlob } = await this.parseEd25519PrivateKey(privateKeyPEM);

    const requestBody = concat(
      new Uint8Array([SSH_MSG_USERAUTH_REQUEST]),
      encodeString(username),
      encodeString('ssh-connection'),
      encodeString('publickey'),
      new Uint8Array([0x01]),
      encodeString('ssh-ed25519'),
      encodeString(publicKeyBlob),
    );

    const dataToSign = concat(encodeString(sessionID), requestBody);
    const rawSignature = new Uint8Array(await crypto.subtle.sign('Ed25519', signingKey, dataToSign));

    const signatureBlob = concat(
      encodeString('ssh-ed25519'),
      encodeString(rawSignature),
    );

    return concat(requestBody, encodeString(signatureBlob));
  }

  private static async parseEd25519PrivateKey(pem: string): Promise<{ signingKey: CryptoKey; publicKeyBlob: Uint8Array }> {
    const lines = pem.trim().split('\n');
    const b64 = lines.filter(l => !l.startsWith('-----')).join('');
    const raw = Uint8Array.from(atob(b64), c => c.charCodeAt(0));

    const magic = 'openssh-key-v1\0';
    const magicBytes = new TextEncoder().encode(magic);
    for (let i = 0; i < magicBytes.length; i++) {
      if (raw[i] !== magicBytes[i]) {
        throw new Error('不支持的私钥格式，仅支持 OpenSSH Ed25519 密钥');
      }
    }
    let offset = magicBytes.length;

    const cipherLen = readUint32(raw, offset); offset += 4;
    const cipher = new TextDecoder().decode(raw.slice(offset, offset + cipherLen)); offset += cipherLen;
    if (cipher !== 'none') throw new Error('不支持加密的私钥，请使用 ssh-keygen -p 移除密码');

    const kdfLen = readUint32(raw, offset); offset += 4; offset += kdfLen;
    const kdfOptLen = readUint32(raw, offset); offset += 4; offset += kdfOptLen;
    const numKeys = readUint32(raw, offset); offset += 4;
    if (numKeys !== 1) throw new Error('仅支持单密钥文件');

    const pubSecLen = readUint32(raw, offset); offset += 4; offset += pubSecLen;

    const privSecLen = readUint32(raw, offset); offset += 4;
    const privSection = raw.slice(offset, offset + privSecLen);

    let po = 0;
    po += 4;
    po += 4;
    const ktLen = readUint32(privSection, po); po += 4;
    const keyType = new TextDecoder().decode(privSection.slice(po, po + ktLen)); po += ktLen;
    if (keyType !== 'ssh-ed25519') throw new Error(`不支持的密钥类型: ${keyType}，仅支持 ssh-ed25519`);

    const pubKeyLen = readUint32(privSection, po); po += 4;
    const pubKeyRaw = privSection.slice(po, po + pubKeyLen); po += pubKeyLen;

    const privKeyLen = readUint32(privSection, po); po += 4;
    const privKeyRaw = privSection.slice(po, po + privKeyLen);
    const seed = privKeyRaw.slice(0, 32);

    const pkcs8 = this.buildEd25519PKCS8(seed);
    const signingKey = await crypto.subtle.importKey(
      'pkcs8', pkcs8, { name: 'Ed25519' }, false, ['sign']
    );

    const publicKeyBlob = concat(
      encodeString('ssh-ed25519'),
      encodeString(pubKeyRaw),
    );

    return { signingKey, publicKeyBlob };
  }

  private static buildEd25519PKCS8(seed: Uint8Array): Uint8Array {
    const oid = new Uint8Array([0x06, 0x03, 0x2b, 0x65, 0x70]);
    const seedOctet = new Uint8Array([0x04, seed.length, ...seed]);
    const innerOctet = new Uint8Array([0x04, seedOctet.length, ...seedOctet]);
    const algoSeq = new Uint8Array([0x30, oid.length, ...oid]);
    const version = new Uint8Array([0x02, 0x01, 0x00]);
    const totalLen = version.length + algoSeq.length + innerOctet.length;
    return new Uint8Array([0x30, totalLen, ...version, ...algoSeq, ...innerOctet]);
  }

  // ── RSA support ──────────────────────────────────────────────────

  private static async buildRSAPublicKeyAuthRequest(
    username: string,
    privateKeyPEM: string,
    sessionID: Uint8Array
  ): Promise<Uint8Array> {
    const { signingKey, publicKeyBlob } = await this.parseRSAPrivateKey(privateKeyPEM);

    const requestBody = concat(
      new Uint8Array([SSH_MSG_USERAUTH_REQUEST]),
      encodeString(username),
      encodeString('ssh-connection'),
      encodeString('publickey'),
      new Uint8Array([0x01]),
      encodeString('ssh-rsa'),
      encodeString(publicKeyBlob),
    );

    const dataToSign = concat(encodeString(sessionID), requestBody);
    const rawSignature = new Uint8Array(
      await crypto.subtle.sign({ name: 'RSA-PKCS1-v1_5', hash: 'SHA-1' }, signingKey, dataToSign)
    );

    const signatureBlob = concat(
      encodeString('ssh-rsa'),
      encodeString(rawSignature),
    );

    return concat(requestBody, encodeString(signatureBlob));
  }

  private static async parseRSAPrivateKey(pem: string): Promise<{ signingKey: CryptoKey; publicKeyBlob: Uint8Array }> {
    const lines = pem.trim().split('\n');
    const b64 = lines.filter(l => !l.startsWith('-----')).join('');
    const raw = Uint8Array.from(atob(b64), c => c.charCodeAt(0));

    // Parse OpenSSH header
    const magic = 'openssh-key-v1\0';
    const magicBytes = new TextEncoder().encode(magic);
    for (let i = 0; i < magicBytes.length; i++) {
      if (raw[i] !== magicBytes[i]) {
        // Try traditional PEM format
        return this.parseTraditionalRSAPem(pem);
      }
    }
    let offset = magicBytes.length;

    const cipherLen = readUint32(raw, offset); offset += 4;
    const cipher = new TextDecoder().decode(raw.slice(offset, offset + cipherLen)); offset += cipherLen;
    if (cipher !== 'none') throw new Error('不支持加密的私钥，请使用 ssh-keygen -p 移除密码');

    const kdfLen = readUint32(raw, offset); offset += 4; offset += kdfLen;
    const kdfOptLen = readUint32(raw, offset); offset += 4; offset += kdfOptLen;
    const numKeys = readUint32(raw, offset); offset += 4;
    if (numKeys !== 1) throw new Error('仅支持单密钥文件');

    const pubSecLen = readUint32(raw, offset); offset += 4;
    const pubSection = raw.slice(offset, offset + pubSecLen); offset += pubSecLen;

    // Parse public section: string keytype, mpint e, mpint n
    let pko = 0;
    const pubKeyTypeLen = readUint32(pubSection, pko); pko += 4;
    const pubKeyType = new TextDecoder().decode(pubSection.slice(pko, pko + pubKeyTypeLen)); pko += pubKeyTypeLen;
    if (pubKeyType !== 'ssh-rsa') throw new Error(`不支持的密钥类型: ${pubKeyType}`);

    const eLen = readUint32(pubSection, pko); pko += 4;
    const e = pubSection.slice(pko, pko + eLen); pko += eLen;
    const nLen = readUint32(pubSection, pko); pko += 4;
    const n = pubSection.slice(pko, pko + nLen); pko += nLen;

    const privSecLen = readUint32(raw, offset); offset += 4;
    const privSection = raw.slice(offset, offset + privSecLen);

    // Parse private section
    const stripLeadingZero = (v: Uint8Array) => {
      let s = 0;
      while (s < v.length - 1 && v[s] === 0) s++;
      return v.slice(s);
    };

    let po = 0;
    po += 4; // checkint1
    po += 4; // checkint2

    const ktLen = readUint32(privSection, po); po += 4;
    po += ktLen; // key type string

    const pubKeyLen2 = readUint32(privSection, po); po += 4;
    po += pubKeyLen2; // public key blob (same as pubSection)

    const dLen = readUint32(privSection, po); po += 4;
    const d = stripLeadingZero(privSection.slice(po, po + dLen)); po += dLen;

    const iqmpLen = readUint32(privSection, po); po += 4;
    const iqmp = stripLeadingZero(privSection.slice(po, po + iqmpLen)); po += iqmpLen;

    const pLen = readUint32(privSection, po); po += 4;
    const p = stripLeadingZero(privSection.slice(po, po + pLen)); po += pLen;

    const qLen = readUint32(privSection, po); po += 4;
    const q = stripLeadingZero(privSection.slice(po, po + qLen)); po += qLen;

    const pkcs8Der = this.buildRSAPKCS8(n, e, d, p, q, iqmp);

    const signingKey = await crypto.subtle.importKey(
      'pkcs8', pkcs8Der,
      { name: 'RSA-PKCS1-v1_5', hash: 'SHA-1' },
      false, ['sign']
    );

    const publicKeyBlob = concat(
      encodeString('ssh-rsa'),
      encodeString(e),
      encodeString(n),
    );

    return { signingKey, publicKeyBlob };
  }

  private static async parseTraditionalRSAPem(pem: string): Promise<{ signingKey: CryptoKey; publicKeyBlob: Uint8Array }> {
    const lines = pem.split('\n');
    const b64 = lines.filter(l => !l.startsWith('-----')).join('');
    const der = Uint8Array.from(atob(b64), c => c.charCodeAt(0));

    const readLen = (buf: Uint8Array, off: number): { v: number; b: number } => {
      const f = buf[off];
      if (f < 0x80) return { v: f, b: 1 };
      const nb = f & 0x7f;
      let v = 0;
      for (let i = 0; i < nb; i++) v = (v << 8) | buf[off + 1 + i];
      return { v, b: 1 + nb };
    };

    const skip = (buf: Uint8Array, off: number): number => {
      off++;
      const { b: br } = readLen(buf, off);
      return off + br + readLen(buf, off).v;
    };

    // Detect PKCS#8: after outer SEQUENCE + INTEGER(0), check for SEQUENCE (algorithm)
    let pos = 0;
    pos++; if (pos >= der.length) throw new Error('无效的 RSA 私钥格式');
    pos += readLen(der, pos).b;

    // INTEGER (version)
    pos = skip(der, pos);

    // After version: if SEQUENCE -> PKCS#8, if INTEGER -> PKCS#1
    if (der[pos] === 0x30) {
      // PKCS#8: skip algorithm identifier
      pos = skip(der, pos);
      // OCTET STRING wrapping PKCS#1
      if (der[pos] !== 0x04) throw new Error('无效的 PKCS#8 格式');
      pos++;
      const { v: innerLen, b: innerBr } = readLen(der, pos);
      pos += innerBr;
      return this.parseAndBuildRSAFromPKCS1(der.slice(pos, pos + innerLen));
    }

    // PKCS#1 - rewind back to start
    return this.parseAndBuildRSAFromPKCS1(der);
  }

  private static async parseAndBuildRSAFromPKCS1(pkcs1: Uint8Array): Promise<{ signingKey: CryptoKey; publicKeyBlob: Uint8Array }> {
    const readLen = (buf: Uint8Array, off: number): { v: number; b: number } => {
      const f = buf[off];
      if (f < 0x80) return { v: f, b: 1 };
      const nb = f & 0x7f;
      let v = 0;
      for (let i = 0; i < nb; i++) v = (v << 8) | buf[off + 1 + i];
      return { v, b: 1 + nb };
    };

    const readInt = (): Uint8Array => {
      if (pkcs1[pos] !== 0x02) throw new Error('无效的 RSA 私钥格式');
      pos++;
      const { v: len, b: br } = readLen(pkcs1, pos);
      pos += br;
      let val = pkcs1.slice(pos, pos + len);
      pos += len;
      if (val.length > 1 && val[0] === 0) val = val.slice(1);
      return val;
    };

    let pos = 0;
    if (pkcs1[pos] !== 0x30) throw new Error('无效的 RSA 私钥格式');
    pos++;
    pos += readLen(pkcs1, pos).b;

    const version = readInt();
    if (version.length !== 1 || version[0] !== 0) throw new Error('不支持的 RSA 私钥版本');

    const n = readInt();
    const e = readInt();
    const d = readInt();
    const p = readInt();
    const q = readInt();
    const exp1 = readInt();
    const exp2 = readInt();
    const iqmp = readInt();

    const pkcs8Der = this.buildRSAPKCS8(n, e, d, p, q, iqmp, exp1, exp2);

    const signingKey = await crypto.subtle.importKey(
      'pkcs8', pkcs8Der,
      { name: 'RSA-PKCS1-v1_5', hash: 'SHA-1' },
      false, ['sign']
    );

    const publicKeyBlob = concat(
      encodeString('ssh-rsa'),
      encodeString(e),
      encodeString(n),
    );

    return { signingKey, publicKeyBlob };
  }

  private static buildRSAPKCS8(
    n: Uint8Array, e: Uint8Array, d: Uint8Array,
    p: Uint8Array, q: Uint8Array, iqmp: Uint8Array,
    exp1?: Uint8Array, exp2?: Uint8Array
  ): Uint8Array {
    const encLen = (len: number): Uint8Array => {
      if (len < 0x80) return new Uint8Array([len]);
      if (len < 0x100) return new Uint8Array([0x81, len]);
      return new Uint8Array([0x82, (len >> 8) & 0xff, len & 0xff]);
    };

    const mkInt = (val: Uint8Array): Uint8Array => {
      let data = val;
      if (data[0] & 0x80) data = new Uint8Array([0x00, ...data]);
      const lenB = encLen(data.length);
      return new Uint8Array([0x02, ...lenB, ...data]);
    };

    const bytesToBigInt = (bytes: Uint8Array): bigint => {
      let r = 0n;
      for (const b of bytes) r = (r << 8n) + BigInt(b);
      return r;
    };

    const bigIntToBytes = (num: bigint): Uint8Array => {
      if (num === 0n) return new Uint8Array([0]);
      const hex = num.toString(16);
      const len = hex.length & 1 ? (hex.length + 1) >> 1 : hex.length >> 1;
      const out = new Uint8Array(len);
      let rem = num, idx = len - 1;
      while (rem > 0n) { out[idx--] = Number(rem & 0xffn); rem >>= 8n; }
      return out;
    };

    const computedExp1 = exp1 || bigIntToBytes(bytesToBigInt(d) % (bytesToBigInt(p) - 1n));
    const computedExp2 = exp2 || bigIntToBytes(bytesToBigInt(d) % (bytesToBigInt(q) - 1n));

    const pkcs1 = concat(
      mkInt(new Uint8Array([0])), mkInt(n), mkInt(e), mkInt(d),
      mkInt(p), mkInt(q), mkInt(computedExp1), mkInt(computedExp2), mkInt(iqmp),
    );
    const pkcs1Seq = new Uint8Array([0x30, ...encLen(pkcs1.length), ...pkcs1]);

    const algOid = new Uint8Array([0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01]);
    const algSeq = new Uint8Array([0x30, 0x0d, ...algOid, 0x05, 0x00]);
    const privOctet = new Uint8Array([0x04, ...encLen(pkcs1Seq.length), ...pkcs1Seq]);
    const ver = new Uint8Array([0x02, 0x01, 0x00]);
    const content = concat(ver, algSeq, privOctet);

    return new Uint8Array([0x30, ...encLen(content.length), ...content]);
  }

  static handleResponse(payload: Uint8Array): AuthResult {
    const msgType = payload[0];

    switch (msgType) {
      case SSH_MSG_USERAUTH_SUCCESS:
        return { success: true };

      case SSH_MSG_USERAUTH_FAILURE: {
        const len = readUint32(payload, 1);
        const methods = new TextDecoder().decode(
          payload.slice(5, 5 + len)
        );
        return {
          success: false,
          allowedMethods: methods.split(','),
        };
      }

      default:
        throw new Error(`Unexpected auth message type: ${msgType}`);
    }
  }
}
