import fs from "node:fs";
import path from "node:path";
import type { IncomingMessage } from "node:http";

import { ApiError } from "./api.js";
import type { AntibudgetPaths } from "./config.js";
import { ingestOfxPaths, isOfxUploadFilename, type IngestResult } from "./ingest.js";

export const MAX_UPLOAD_BODY_BYTES = 32 * 1024 * 1024;

export interface ParsedUploadFile {
  filename: string;
  data: Buffer;
}

export interface IngestUploadFileError {
  filename: string;
  message: string;
}

export interface IngestUploadResponse extends IngestResult {
  errors: number;
  fileErrors?: IngestUploadFileError[];
}

function errnoCode(err: unknown): string | undefined {
  if (err && typeof err === "object" && "code" in err) {
    return (err as NodeJS.ErrnoException).code;
  }
  return undefined;
}

function isSystemIoError(err: unknown): boolean {
  const code = errnoCode(err);
  return code === "EACCES" || code === "ENOSPC" || code === "EPERM" || code === "EIO";
}

function isParseIngestError(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false;
  }
  const message = err.message;
  return (
    message.startsWith("OFX parse error:") ||
    message.startsWith("Invalid TRNAMT") ||
    message.startsWith("Invalid DTPOSTED") ||
    message.startsWith("Invalid BALAMT") ||
    message.includes("Ingest path is not an OFX/QFX file")
  );
}

function publicFileErrorMessage(err: unknown): string {
  if (isSystemIoError(err)) {
    return "Import failed";
  }
  if (isParseIngestError(err)) {
    return "Invalid or unreadable OFX/QFX export";
  }
  return "Import failed";
}

function parseContentTypeBoundary(contentType: string): string | null {
  const match = contentType.match(/boundary=(?:"([^"]+)"|([^;\s]+))/i);
  if (!match) {
    return null;
  }
  return match[1] ?? match[2] ?? null;
}

function parseContentDispositionFilename(header: string): string | null {
  const star = header.match(/filename\*=(?:UTF-8''|utf-8'')([^;\s]+)/i);
  if (star?.[1]) {
    try {
      return path.basename(decodeURIComponent(star[1].trim()));
    } catch {
      return null;
    }
  }
  const quoted = header.match(/filename="([^"]+)"/i);
  if (quoted?.[1]) {
    return path.basename(quoted[1]);
  }
  const bare = header.match(/filename=([^;\s]+)/i);
  if (bare?.[1]) {
    return path.basename(bare[1].replace(/^"|"$/g, ""));
  }
  return null;
}

async function readRequestBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const contentLength = req.headers["content-length"];
  if (contentLength) {
    const declared = Number.parseInt(contentLength, 10);
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new ApiError(413, "Upload too large");
    }
  }

  const chunks: Buffer[] = [];
  let total = 0;
  let rejected: ApiError | undefined;

  await new Promise<void>((resolve, reject) => {
    const finish = (): void => {
      resolve();
    };
    req.on("data", (chunk: Buffer | string) => {
      if (rejected) {
        return;
      }
      const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      total += buf.length;
      if (total > maxBytes) {
        rejected = new ApiError(413, "Upload too large");
        req.removeAllListeners("data");
        req.on("data", () => {});
        req.resume();
        finish();
        return;
      }
      chunks.push(buf);
    });
    req.on("end", finish);
    req.on("error", (err) => reject(err));
  });

  if (rejected) {
    throw rejected;
  }
  return Buffer.concat(chunks);
}

/** Parses multipart/form-data file parts (field name ignored). */
export function parseMultipartFiles(body: Buffer, boundary: string): ParsedUploadFile[] {
  const files: ParsedUploadFile[] = [];
  const opening = Buffer.from(`--${boundary}`);
  const partDelimiter = Buffer.from(`\r\n--${boundary}`);

  if (!body.subarray(0, opening.length).equals(opening)) {
    return files;
  }

  let start = opening.length;
  if (body[start] === 13 && body[start + 1] === 10) {
    start += 2;
  }

  while (start < body.length) {
    const headerEnd = body.indexOf("\r\n\r\n", start);
    if (headerEnd === -1) {
      break;
    }
    const headerBlock = body.subarray(start, headerEnd).toString("utf8");
    const dataStart = headerEnd + 4;
    const next = body.indexOf(partDelimiter, dataStart);
    if (next === -1) {
      break;
    }
    const afterDelimiter = next + partDelimiter.length;
    const isClosing = body[afterDelimiter] === 45 && body[afterDelimiter + 1] === 45;
    const dataEnd = next;
    const disposition = headerBlock
      .split("\r\n")
      .find((line) => line.toLowerCase().startsWith("content-disposition:"));
    if (disposition) {
      const filename = parseContentDispositionFilename(disposition);
      if (filename) {
        files.push({ filename, data: body.subarray(dataStart, dataEnd) });
      }
    }
    if (isClosing) {
      break;
    }
    start = afterDelimiter;
    if (body[start] === 13 && body[start + 1] === 10) {
      start += 2;
    }
  }
  return files;
}

export async function readMultipartUploadFiles(req: IncomingMessage): Promise<ParsedUploadFile[]> {
  const rawType = req.headers["content-type"];
  const contentType = typeof rawType === "string" ? rawType : rawType?.[0];
  if (!contentType?.toLowerCase().startsWith("multipart/form-data")) {
    throw new ApiError(400, "Content-Type must be multipart/form-data");
  }
  const boundary = parseContentTypeBoundary(contentType);
  if (!boundary) {
    throw new ApiError(400, "Missing multipart boundary");
  }
  const body = await readRequestBody(req, MAX_UPLOAD_BODY_BYTES);
  const files = parseMultipartFiles(body, boundary);
  if (files.length === 0) {
    throw new ApiError(400, "No files in upload");
  }
  return files;
}

function validateUploadFilenames(files: ParsedUploadFile[]): void {
  const rejected = files.filter((f) => !isOfxUploadFilename(f.filename));
  if (rejected.length > 0) {
    const names = rejected.map((f) => f.filename).join(", ");
    throw new ApiError(
      400,
      `Only .ofx and .qfx files are accepted; rejected: ${names}`,
    );
  }
}

function uniqueBasename(dir: string, filename: string): string {
  const ext = path.extname(filename);
  const stem = path.basename(filename, ext);
  let candidate = filename;
  let n = 1;
  while (fs.existsSync(path.join(dir, candidate))) {
    candidate = `${stem}-${n}${ext}`;
    n += 1;
  }
  return candidate;
}

export function ingestUploadedFiles(
  paths: AntibudgetPaths,
  files: ParsedUploadFile[],
): IngestUploadResponse {
  validateUploadFilenames(files);
  fs.mkdirSync(paths.inbox, { recursive: true });
  const stagingDir = fs.mkdtempSync(path.join(paths.home, "upload-"));
  const staged: { filename: string; filePath: string }[] = [];
  try {
    for (const file of files) {
      const name = uniqueBasename(stagingDir, path.basename(file.filename));
      const filePath = path.join(stagingDir, name);
      fs.writeFileSync(filePath, file.data);
      staged.push({ filename: file.filename, filePath });
    }

    let filesProcessed = 0;
    let transactionsInserted = 0;
    let transactionsSkipped = 0;
    let errors = 0;
    const fileErrors: IngestUploadFileError[] = [];
    let hadSystemError = false;

    for (const entry of staged) {
      try {
        const result = ingestOfxPaths({ paths, sourcePath: entry.filePath });
        filesProcessed += result.filesProcessed;
        transactionsInserted += result.transactionsInserted;
        transactionsSkipped += result.transactionsSkipped;
      } catch (err) {
        errors += 1;
        fileErrors.push({
          filename: entry.filename,
          message: publicFileErrorMessage(err),
        });
        if (isSystemIoError(err)) {
          hadSystemError = true;
        }
      }
    }

    if (filesProcessed === 0 && errors > 0) {
      if (hadSystemError) {
        throw new ApiError(500, "Import failed");
      }
      throw new ApiError(
        422,
        fileErrors[0]?.message ?? "Invalid or unreadable OFX/QFX export",
      );
    }

    return {
      filesProcessed,
      transactionsInserted,
      transactionsSkipped,
      errors,
      ...(fileErrors.length > 0 ? { fileErrors } : {}),
    };
  } finally {
    try {
      fs.rmSync(stagingDir, { recursive: true, force: true });
    } catch {
      // staging dir may be empty after archive moves
    }
  }
}

export async function handleIngestUpload(
  paths: AntibudgetPaths,
  req: IncomingMessage,
): Promise<IngestUploadResponse> {
  const files = await readMultipartUploadFiles(req);
  return ingestUploadedFiles(paths, files);
}
