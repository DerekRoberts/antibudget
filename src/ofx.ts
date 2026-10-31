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
  const acctId = extractTag(raw, "ACCTID", xmlLike);
  if (!acctId) {
    throw new Error("OFX parse error: missing ACCTID");
  }

  let ledgerBalanceCents: number | null = null;
  const balAmt = extractNestedAmount(raw, "LEDGERBAL", "BALAMT", xmlLike);
  if (balAmt !== null) {
    ledgerBalanceCents = dollarsToCents(balAmt);
  }

  const transactions: ParsedOfxTransaction[] = [];
  const blocks = extractStmtTrnBlocks(raw, xmlLike);
  for (const block of blocks) {
    const fitid = extractTag(block, "FITID", xmlLike);
    const trnAmt = extractTag(block, "TRNAMT", xmlLike);
    const dtPosted = extractTag(block, "DTPOSTED", xmlLike);
    if (!fitid || trnAmt === null || !dtPosted) {
      continue;
    }
    const name = extractTag(block, "NAME", xmlLike);
    const memo = extractTag(block, "MEMO", xmlLike);
    transactions.push({
      fitid,
      amountCents: dollarsToCents(trnAmt),
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
  if (xml) {
    const re = new RegExp(`<${tag}>([^<]*)</${tag}>`, "i");
    const m = content.match(re);
    return m ? decodeXmlEntities(m[1].trim()) : null;
  }
  const re = new RegExp(`<${tag}>([^\\r\\n<]+)`, "i");
  const m = content.match(re);
  return m ? m[1].trim() : null;
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

function dollarsToCents(amount: string): number {
  const normalized = amount.replace(/,/g, "").trim();
  const value = Number.parseFloat(normalized);
  if (Number.isNaN(value)) {
    throw new Error(`Invalid TRNAMT/BALAMT: ${amount}`);
  }
  return Math.round(value * 100);
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
