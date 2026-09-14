# foobiz-desktop

Apps Electron (PDV, KDS, Totem) extraídos do monorepo FOOBIZ.

## Desenvolvimento

Desde a separação de apps no monorepo FOOBIZ, PDV, KDS e Totem são SPAs
independentes (`apps/pdv`, `apps/kds`, `apps/totem`), cada uma com seu
próprio dev server Vite em uma porta fixa: PDV `5177`, KDS `5175`,
Totem `5176`. `src/main.js` já resolve a porta certa automaticamente a
partir de `FOOBIZ_APP` — não é preciso setar `VITE_DEV_SERVER_URL` no dia a
dia (ela continua disponível como override manual, se precisar apontar para
outra porta/host).

No repositório FOOBIZ, suba o app correspondente:

```bash
cd frontend
npm run dev:pdv   # ou dev:kds / dev:totem
```

E aqui, no foobiz-desktop:

```bash
npm install
npm run dev:pdv   # ou dev:kds / dev:totem
```

## Build local (manual)

O build de produção espera `frontend/dist/` na raiz deste repositório
(pasta ignorada pelo git), contendo o build de **um único app por vez** —
não o `dist/` inteiro do monorepo (que agora tem 5 pastas: tenant, admin,
kds, totem, pdv). Para buildar manualmente:

1. No repositório FOOBIZ, rode `cd frontend && npm run build:pdv` (ou
   `build:kds` / `build:totem`).
2. Copie o conteúdo de `frontend/dist/pdv` (ou `dist/kds` / `dist/totem`)
   para a raiz deste repositório, em `foobiz-desktop/frontend/dist`
   (o `index.html` deve ficar direto em `frontend/dist/index.html`, não em
   uma subpasta).
3. Rode `npm run build:pdv` (ou `:kds` / `:totem`) — o app buildado precisa
   corresponder ao dist copiado no passo 2.

## Release automática (CI)

O pipeline é acionado ao dar push de uma tag `v*` no repositório **FOOBIZ**:

1. O workflow `desktop-release.yml` no FOOBIZ builda os 3 apps (pdv, kds,
   totem — cada um uma SPA independente) e publica `pdv-dist.zip`,
   `kds-dist.zip` e `totem-dist.zip` como assets de uma release (pre-release)
   no próprio FOOBIZ.
2. Ele então dispara (`repository_dispatch`) o workflow `build-and-release.yml`
   deste repositório, passando a versão.
3. Este repositório baixa os 3 zips da release do FOOBIZ (via
   `gh release download`, autenticado — a release é de um repo privado),
   e para cada app copia o zip correspondente para `frontend/dist` antes de
   buildar aquele instalador — builda os 3 instaladores Windows em sequência
   e publica a release aqui (`paulo724/foobiz-desktop`) via
   `electron-builder --publish always`.
4. O `electron-updater` embutido em cada app (ver `src/updater.js`) consulta
   essas releases automaticamente e instala a atualização.

### Setup necessário (uma vez)

**No repositório FOOBIZ** (`solubiztecnologia/FOOBIZ` → Settings → Secrets and variables → Actions):

- `DESKTOP_REPO_TOKEN`: um GitHub Personal Access Token (fine-grained, com
  permissão `Contents: Read and write` e `Actions: Read and write` apenas no
  repositório `paulo724/foobiz-desktop`, ou um classic PAT com escopo `repo`)
  usado para disparar o `repository_dispatch` no repo desktop.
  Gere em https://github.com/settings/tokens e cole o valor como secret.

**Neste repositório** (`paulo724/foobiz-desktop` → Settings → Secrets and variables → Actions):

- `FOOBIZ_READ_TOKEN`: um GitHub Personal Access Token (fine-grained, com
  permissão `Contents: Read` no repositório `solubiztecnologia/FOOBIZ`, ou um
  classic PAT com escopo `repo`) usado para baixar o `frontend-dist.zip` da
  release do FOOBIZ (repo privado — não dá para baixar assets sem autenticação).
- O `GITHUB_TOKEN` automático do próprio repositório já é suficiente para
  publicar a release aqui (permissão `contents: write` concedida via
  `permissions:` no workflow).

### Disparando uma release

```bash
# no repositório FOOBIZ
git tag v1.4.0
git push origin v1.4.0
```

Isso builda o frontend, e em seguida builda e publica os 3 instaladores
aqui automaticamente. Acompanhe em Actions nos dois repositórios.
