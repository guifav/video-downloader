// Link para "Enviar gravação" so para quem pode enviar (UPLOAD_EMAILS). Fora do script principal da
// pagina de propósito: nao muda o fluxo de download nem os testes dele.
"use strict";
fetch("/api/me", { credentials: "same-origin", redirect: "manual" })
	.then((res) => (res.ok ? res.json() : null))
	.then((me) => {
		if (!me || !me.canUpload) return;
		const link = document.getElementById("upload-link");
		if (link) link.hidden = false;
	})
	.catch(() => {});
