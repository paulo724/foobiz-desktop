# foobiz-desktop

Apps Electron (PDV, KDS, Totem) extraídos do monorepo FOOBIZ.

## Desenvolvimento

O código consome o frontend Vue via `VITE_DEV_SERVER_URL` (ver `.env.example`) —
rode o servidor Vite do repositório `FOOBIZ/frontend` normalmente e aponte
essa URL para ele.

```bash
npm install
npm run dev:pdv   # ou dev:kds / dev:totem
```

## Build local (manual)

O build de produção espera `frontend/dist/` na raiz deste repositório
(pasta ignorada pelo git). Para buildar manualmente:

1. No repositório FOOBIZ, rode `cd frontend && npm run build`.
2. Copie `frontend/dist` para a raiz deste repositório (`foobiz-desktop/frontend/dist`).
3. Rode `npm run build:pdv` (ou `:kds` / `:totem` / `:all`).

## Release automática (CI)

O pipeline é acionado ao dar push de uma tag `v*` no repositório **FOOBIZ**:

1. O workflow `desktop-release.yml` no FOOBIZ builda o frontend e publica
   `frontend-dist.zip` como asset de uma release (pre-release) no próprio FOOBIZ.
2. Ele então dispara (`repository_dispatch`) o workflow `build-and-release.yml`
   deste repositório, passando a versão.
3. Este repositório baixa o `frontend-dist.zip` da release do FOOBIZ (via
   `gh release download`, autenticado — a release é de um repo privado),
   builda os 3 instaladores Windows e publica a release aqui
   (`paulo724/foobiz-desktop`) via `electron-builder --publish always`.
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
