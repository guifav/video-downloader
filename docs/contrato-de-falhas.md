# Contrato de falhas do backend

> English summary: see "Design invariants" in [CONTRIBUTING.md](../CONTRIBUTING.md). This file is the
> original, more detailed version in Portuguese; code comments reference it.

Garantia: at-least-once com reconciliação pelo R2. O sistema tem um usuário só. Falha de
infraestrutura (storage do Durable Object, R2, container, rede) pode custar reexecução ou
reenvio do job. Nunca pode custar segurança, arquivo corrompido ou gasto sem teto.

## Invariantes (violação bloqueia)

- I1 Entrada e rede: só URL canônica de vídeo avulso do YouTube, do X, do Instagram ou do
  Facebook chega ao container; só o extrator da plataforma roda; as conexões do yt-dlp só saem
  para endereço público. Além da busca fixa das chaves do Access (`src/access.ts`, URL montada da configuração), a única
  requisição que o Worker faz a partir de entrada do usuário resolve links de compartilhamento do
  Facebook (`src/share.ts`): cada salto é reconstruído a partir do token em
  `www.facebook.com`, no máximo 3 saltos com 8 s cada, e o destino final passa pelo mesmo parser
  das URLs diretas. Nenhuma URL vinda de `Location` é buscada como veio.
- I2 Exposição: o Worker não responde fora do Cloudflare Access. `workers_dev` e
  `preview_urls` ficam desligados, e a única rota passa pela validação do JWT, que falha fechada.
- I3 Integridade: o objeto `files/<id>` é sempre o arquivo completo declarado pelo container
  (tamanho fixo, put atômico). Arquivo parcial nunca é servido. Job `done` sem objeto
  aparece como `expired`.
- I4 Custo limitado: cada job executa o container (`standard-4`) no máximo `MAX_ATTEMPTS` (3)
  vezes. Em cada execução, o prazo de 14 min do motor cobre prontidão, download e gravação no R2;
  a limpeza depois de uma gravação que falhou (`files.delete`), a subida e a destruição do
  container ficam sob o teto de 15 min do runtime. Elas não são abandonadas no prazo do motor,
  porque um delete tardio poderia apagar o objeto da execução seguinte. Estourar o prazo antes
  de o container responder (vídeo longo demais, live) é falha terminal, sem nova execução. Um job
  não terminal com mais de 2 h de vida termina em `failed`. A tentativa é
  gravada antes de o container subir, então nenhuma falha de storage aumenta esse número. O
  container é destruído ao fim de cada execução; se a destruição falhar, o timeout de inatividade
  o encerra. A conversão para H.264 roda dentro da execução, com prazo próprio (`budget_ms`, o
  restante menos a reserva do upload): probe, conversão e probe da saída são limitados pelo
  tempo restante, e o prazo é fiscalizado por relógio mesmo com o ffmpeg em silêncio. A conversão
  desiste antes do prazo e nunca cria tentativa.
- I5 Sem laço quente: toda reexecução é agendada por alarm com espera mínima (30 s para job
  ativo, 10 min para limpeza). Fora disso só existem as até 6 retentativas do runtime, com backoff.
  O watchdog da consulta (`GET /api/jobs/:id`, lista e smoke) só agenda quando o job não tem
  alarm pendente, e sempre para daqui a 30 s: consultar nunca adianta um alarm nem gasta tentativa.
- I6 Caminho normal: sem falha de infraestrutura, o job termina em `done` ou em `failed` com a
  mensagem real do yt-dlp, e arquivo e estado somem 24 h depois do fim. O arquivo de um job
  `done` sai em H.264, ou sai como veio com aviso (`warning`) visível na UI. O aviso é gravado no
  `customMetadata` do R2 junto com o arquivo, então sobrevive à reconciliação; o mesmo vale para o
  codec de origem e as dimensões entregues, que a UI mostra como resolução ("720p"). A conversão só
  substitui o original depois de terminar com sucesso e de o ffprobe confirmar H.264 (I3).

## Desfechos aceitos sob falha de infraestrutura (não bloqueiam)

- A9 Smoke semanal: os jobs do smoke seguem I1 a I6 como qualquer job e não aparecem na lista
  da UI (índice próprio). O caso da conversão longa só passa se o codec de origem informado pelo
  container não for H.264 e o arquivo sair sem aviso (ou seja, em H.264). Se o cron de checagem não rodar ou o email falhar, a rodada fica sem
  relatório; a seguinte volta ao normal.

- A1 Download repetido, dentro do teto de I4. Se o objeto já está no R2, a reconciliação
  conclui sem baixar de novo; se o que não foi gravado era um resultado de falha (inclusive um
  422 do yt-dlp), a reexecução gasta outra tentativa.
- A2 Job que precisa ser reenviado: termina em `failed` por falha de infraestrutura. Se o
  storage do próprio Durable Object falha além das retentativas do runtime, o job fica sem alarm
  sucessor só até a próxima consulta: o watchdog o rearma. Se ninguém consultar, o resíduo é um
  registro de poucos bytes, sem container. Rearmado depois de 2 h, termina em `failed` sem baixar
  (salvo se o arquivo já estiver no R2: a reconciliação conclui como `done`).
- A3 Espera enquanto o R2 estiver fora: o job se reagenda a cada 30 s sem gastar tentativa e
  termina em `failed` passadas 2 h da criação (o teto de 2 h também limita as retentativas
  durante uma indisponibilidade longa). A limpeza se reagenda a cada 10 min; dois dias depois do
  vencimento, apaga só o estado, e a remoção do arquivo fica com o lifecycle do bucket (A4). Sem o
  estado, `GET /api/files/:id` responde 404 mesmo que o objeto ainda exista.
- A4 Limpeza atrasada: o arquivo pode passar de 24 h até o lifecycle de 1 dia do bucket removê-lo
  (prazo típico, não garantido pela Cloudflare). O arquivo só é servido enquanto o job existe e
  está `done`.
- A5 A classificação de erro do yt-dlp é heurística. Erro permanente tratado como transitório
  custa no máximo as tentativas de I4; transitório tratado como permanente termina em `failed`
  com a mensagem real, e o usuário reenvia. Ajuste de marcador entra por issue, com a ocorrência real.
- A6 Live em andamento ou agendada: quando o extrator informa (`is_live`, `live_status`), o
  container recusa antes de baixar (422, terminal), interrompendo a extração; num carrossel, só o
  item escolhido é julgado. Live agendada sem formatos pode falhar antes, com a mensagem do
  próprio yt-dlp (também 422). `post_live` (encerrada, VOD em processamento) não é recusada. O do Facebook não expõe isso; ali o pior caso
  é uma execução até o prazo de 14 min, terminando em `failed` com a mensagem do limite, e
  `/watch/live/` é recusado no parser.
- A7 Link de compartilhamento do Facebook depende de comportamento não documentado (302 para
  cliente que não é navegador). Se mudar, o envio responde 400 com mensagem para copiar o link do
  vídeo; nenhum job é criado. O smoke semanal (`src/smoke.ts`, caso `facebook-share`) cobre
  esse caminho.
- A8 Arquivo fora do padrão: vídeo longo demais para converter no prazo, ou conversão que falha,
  é entregue como veio, com aviso. Não é falha.

## Regra de revisão

Bloqueia: cenário concreto que viole I1 a I6, falha de segurança demonstrada, ou defeito no
caminho normal. Não bloqueia: cenário que só demonstre A1 a A9; ele vira nota na issue de follow-up.
