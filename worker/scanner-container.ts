import { DurableObject } from "cloudflare:workers";
import type { Bindings } from "./types";

const COMMAND_TIMEOUT_MS = 3 * 60 * 1000;
const MAX_SIGNATURE_AGE_MS = 24 * 60 * 60 * 1000;

export class ScannerContainer extends DurableObject<Bindings> {
  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (request.method === "GET" && path === "/health") return this.health();
    if (request.method === "POST" && path === "/scan") return this.scan(request);
    return new Response("Not found", { status: 404 });
  }

  private async health(): Promise<Response> {
    try {
      const version = await this.runClamCommand(["clamscan", "--version"]);
      const signature = signatureDateFromVersion(version.stdout);
      const fresh = signature !== null && Date.now() - signature <= MAX_SIGNATURE_AGE_MS && signature <= Date.now() + 5 * 60 * 1000;
      return Response.json({
        ok: fresh,
        scannerVersion: version.stdout.trim(),
        signatureAt: signature === null ? null : new Date(signature).toISOString(),
      }, { status: fresh ? 200 : 503 });
    } catch {
      return Response.json({ ok: false, error: "scanner_unavailable" }, { status: 503 });
    }
  }

  private async scan(request: Request): Promise<Response> {
    if (!request.body) return Response.json({ error: "missing_file_body" }, { status: 400 });
    const rawSize = Number(request.headers.get("Content-Length"));
    if (Number.isFinite(rawSize) && rawSize > 20 * 1024 * 1024) return Response.json({ error: "file_too_large" }, { status: 413 });
    try {
      const result = await this.runClamCommand([
        "sh", "-c",
        `file="$(mktemp /tmp/zellink-scan.XXXXXX)" || exit 90
trap 'rm -f "$file"' EXIT
cat > "$file" || exit 91
version="$(clamscan --version 2>/dev/null)" || exit 92
clamscan "$file"
scan_status="$?"
printf '\\nZELLINK_VERSION:%s\\nZELLINK_RESULT:%s\\n' "$version" "$scan_status"
exit 0`,
      ], request.body);
      const version = result.stdout.match(/ZELLINK_VERSION:([^\r\n]+)/u)?.[1]?.trim() ?? "";
      const exitText = result.stdout.match(/ZELLINK_RESULT:(\d+)/u)?.[1];
      const exitCode = exitText === undefined ? 2 : Number(exitText);
      const signature = signatureDateFromVersion(version);
      const fresh = signature !== null && Date.now() - signature <= MAX_SIGNATURE_AGE_MS && signature <= Date.now() + 5 * 60 * 1000;
      if (!fresh || exitCode > 1 || result.commandExitCode !== 0) {
        return Response.json({ result: "error", scannerVersion: version || null, signatureAt: signature ? new Date(signature).toISOString() : null }, { status: 503 });
      }
      return Response.json({
        result: exitCode === 0 ? "clean" : "infected",
        scannerVersion: version,
        signatureAt: new Date(signature).toISOString(),
      });
    } catch {
      return Response.json({ error: "scanner_unavailable" }, { status: 503 });
    }
  }

  private async runClamCommand(command: string[], stdin?: ReadableStream<Uint8Array>): Promise<{ stdout: string; commandExitCode: number }> {
    const container = this.ctx.container;
    if (!container) throw new Error("scanner_container_missing");
    if (!container.running) {
      container.start({
        image: container.images.base,
        enableInternet: true,
        env: { CLAMAV_NO_MILTERD: "true", FRESHCLAM_CHECKS: "4" },
      });
    }
    const process = await container.exec(command, { stdin, stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => process.kill(), COMMAND_TIMEOUT_MS);
    try {
      const [output, commandExitCode] = await Promise.all([process.output(), process.exitCode]);
      return { stdout: new TextDecoder().decode(output.stdout), commandExitCode };
    } finally {
      clearTimeout(timer);
    }
  }
}

function signatureDateFromVersion(version: string): number | null {
  const match = version.match(/\/\d+\/(.+)$/u);
  if (!match?.[1]) return null;
  const value = Date.parse(match[1].trim());
  return Number.isFinite(value) ? value : null;
}
