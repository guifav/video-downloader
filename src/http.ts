// Leitura de corpo com limite real em bytes: para de ler no limite, independentemente do
// Content-Length declarado pelo cliente.

export type LimitedText = { ok: true; text: string } | { ok: false; status: 400 | 413; error: string };

export async function readLimitedText(request: Request, maxBytes: number): Promise<LimitedText> {
	const declared = request.headers.get("content-length");
	if (declared !== null && Number(declared) > maxBytes) {
		await request.body?.cancel();
		return { ok: false, status: 413, error: "Corpo grande demais." };
	}
	if (!request.body) return { ok: true, text: "" };

	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > maxBytes) {
			await reader.cancel();
			return { ok: false, status: 413, error: "Corpo grande demais." };
		}
		chunks.push(value);
	}
	const buffer = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		buffer.set(chunk, offset);
		offset += chunk.byteLength;
	}
	try {
		return { ok: true, text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(buffer) };
	} catch {
		return { ok: false, status: 400, error: "Corpo nao e UTF-8 valido." };
	}
}
