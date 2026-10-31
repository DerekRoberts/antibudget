import fs from "node:fs";

export interface ParsedOfxAccount {
  acctId: string;
  ledgerBalanceCents: number | null;
}

export interface ParsedOfxTransaction {
  fitid: string;
  amountCents: number;
  postedAt: string;
  payee: string | null;
  memo: string | null;
}

export interface ParsedOfxStatement {
  account: ParsedOfxAccount;
  transactions: ParsedOfxTransaction[];
}

/** Parse an OFX or QFX file (SGML v1 or XML v2). */
export function parseOfxFile(filePath: string): ParsedOfxStatement {
  const raw = fs.readFileSync(filePath, "utf8");
  return parseOfxContent(raw);
}

export function parseOfxContent(raw: string): ParsedOfxStatement {
  const xmlLike = isXmlOfx(raw);
  const acctIds = uniqueNonEmpty(extractAllTags(raw, "ACCTID", xmlLike));
  if (acctIds.length === 0) {
    throw new Error("OFX parse error: missing ACCTID");
  }
  if (acctIds.length > 1) {
    throw new Error(
      `OFX parse error: multiple ACCTID values (${acctIds.join(", ")}); split into one account per file`,
    );
  }
  const acctId = acctIds[0];

  let ledgerBalanceCents: number | null = null;
  const balAmt = extractNestedAmount(raw, "LEDGERBAL", "BALAMT", xmlLike);
  if (balAmt !== null) {
    ledgerBalanceCents = ofxAmountToCents(balAmt);
  }

  const transactions: ParsedOfxTransaction[] = [];
  const blocks = extractStmtTrnBlocks(raw, xmlLike);
  for (const block of blocks) {
    const fitid = extractTag(block, "FITID", xmlLike);
    const trnAmt = extractTag(block, "TRNAMT", xmlLike);
    const dtPosted = extractTag(block, "DTPOSTED", xmlLike);
    if (!fitid || trnAmt === null || !dtPosted) {
      throw new Error(
        "OFX parse error: STMTTRN missing required FITID, TRNAMT, or DTPOSTED",
      );
    }
    const name = extractTag(block, "NAME", xmlLike);
    const memo = extractTag(block, "MEMO", xmlLike);
    transactions.push({
      fitid,
      amountCents: ofxAmountToCents(trnAmt),
      postedAt: ofxDateToIso(dtPosted),
      payee: name,
      memo: memo ?? name,
    });
  }

  return {
    account: { acctId, ledgerBalanceCents },
    transactions,
  };
}

function isXmlOfx(raw: string): boolean {
  const trimmed = raw.trimStart();
  if (trimmed.startsWith("<?xml") || trimmed.startsWith("<OFX")) {
    return true;
  }
  return /<OFX>\s*<\/?OFX>/i.test(raw) || /<OFX xmlns/i.test(raw);
}

function extractTag(content: string, tag: string, xml: boolean): string | null {
  const all = extractAllTags(content, tag, xml);
  return all[0] ?? null;
}

function extractAllTags(content: string, tag: string, xml: boolean): string[] {
  const values: string[] = [];
  if (xml) {
    const re = new RegExp(`<${tag}>([^<]*)</${tag}>`, "gi");
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      values.push(decodeXmlEntities(m[1].trim()));
    }
    return values;
  }
  const re = new RegExp(`<${tag}>([^\\r\\n<]+)`, "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    values.push(m[1].trim());
  }
  return values;
}

function uniqueNonEmpty(values: string[]): string[] {
  return [...new Set(values.filter((v) => v.length > 0))];
}

function extractNestedAmount(
  content: string,
  outer: string,
  inner: string,
  xml: boolean,
): string | null {
  const outerRe = xml
    ? new RegExp(`<${outer}>[\\s\\S]*?</${outer}>`, "i")
    : new RegExp(`<${outer}>[\\s\\S]*?(?=<${outer}>|<${outer}/|$)`, "i");
  const block = content.match(outerRe)?.[0];
  if (!block) {
    return null;
  }
  return extractTag(block, inner, xml);
}

function extractStmtTrnBlocks(content: string, xml: boolean): string[] {
  if (xml) {
    const re = /<STMTTRN>([\s\S]*?)<\/STMTTRN>/gi;
    const blocks: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      blocks.push(m[0]);
    }
    return blocks;
  }
  const re = /<STMTTRN>([\s\S]*?)(?=<STMTTRN>|<\/?BANKTRANLIST|<\/BANKTRANLIST|<\/STMTRS)/gi;
  const blocks: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    blocks.push(m[0]);
  }
  if (blocks.length === 0) {
    const fallback = /<STMTTRN>[\s\S]*/gi;
    const fm = content.match(fallback);
    if (fm) {
      blocks.push(...fm);
    }
  }
  return blocks;
}

/** Parse OFX monetary amounts into signed integer cents without floating point. */
export function ofxAmountToCents(amount: string): number {
  let s = amount.trim();
  if (!s) {
    throw new Error(`Invalid TRNAMT/BALAMT: ${amount}`);
  }

  let negative = false;
  if (s.startsWith("-")) {
    negative = true;
    s = s.slice(1).trim();
  } else if (s.startsWith("+")) {
    s = s.slice(1).trim();
  }

  const lastComma = s.lastIndexOf(",");
  const lastDot = s.lastIndexOf(".");
  let normalized: string;

  if (lastComma !== -1 && lastDot !== -1) {
    if (lastComma > lastDot) {
      normalized = s.replace(/\./g, "").replace(",", ".");
    } else {
      normalized = s.replace(/,/g, "");
    }
  } else if (lastComma !== -1) {
    const fracLen = s.length - lastComma - 1;
    normalized = fracLen === 2 ? s.replace(",", ".") : s.replace(/,/g, "");
  } else if (lastDot !== -1) {
    const fracLen = s.length - lastDot - 1;
    if (fracLen === 2 || fracLen === 1) {
      normalized = s;
    } else if (/^\d{1,3}(\.\d{3})+$/.test(s)) {
      normalized = s.replace(/\./g, "");
    } else {
      normalized = s;
    }
  } else {
    normalized = s;
  }

  return decimalStringToCents(normalized, negative, amount);
}

function decimalStringToCents(normalized: string, negative: boolean, raw: string): number {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(normalized);
  if (!match) {
    throw new Error(`Invalid TRNAMT/BALAMT: ${raw}`);
  }

  const wholePart = match[1];
  let fracPart = match[2] ?? "";
  if (fracPart.length > 2) {
    const roundUp = fracPart[2] >= "5";
    fracPart = fracPart.slice(0, 2);
    let whole = BigInt(wholePart);
    let frac = BigInt((fracPart + "00").slice(0, 2));
    if (roundUp) {
      frac += 1n;
      if (frac >= 100n) {
        whole += 1n;
        frac -= 100n;
      }
    }
    const cents = whole * 100n + frac;
    const signed = negative ? -cents : cents;
    if (signed < BigInt(Number.MIN_SAFE_INTEGER) || signed > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error(`Invalid TRNAMT/BALAMT: ${raw}`);
    }
    return Number(signed);
  }

  const fracPadded = (fracPart + "00").slice(0, 2);
  const cents = BigInt(wholePart) * 100n + BigInt(fracPadded);
  const signed = negative ? -cents : cents;
  return Number(signed);
}

function ofxDateToIso(dtPosted: string): string {
  const digits = dtPosted.replace(/\D/g, "");
  if (digits.length < 8) {
    throw new Error(`Invalid DTPOSTED: ${dtPosted}`);
  }
  const year = digits.slice(0, 4);
  const month = digits.slice(4, 6);
  const day = digits.slice(6, 8);
  const hour = digits.length >= 10 ? digits.slice(8, 10) : "00";
  const minute = digits.length >= 12 ? digits.slice(10, 12) : "00";
  const second = digits.length >= 14 ? digits.slice(12, 14) : "00";
  return `${year}-${month}-${day}T${hour}:${minute}:${second}Z`;
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}
