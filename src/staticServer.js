const https = require('https')
const fs = require('fs')
const path = require('path')
const selfsigned = require('selfsigned')

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
  '.wasm': 'application/wasm',
}

// Porta fixa para que a origem https://127.0.0.1:PORT seja previsível e possa
// ser liberada no CORS/Sanctum do backend (não aceitam portas dinâmicas).
const PREFERRED_PORT = 47391

// O backend seta o cookie de sessão da estação com Secure=true, então o
// navegador só o reenvia em conexões HTTPS — por isso servimos via HTTPS
// local com certificado autoassinado, cacheado em disco entre execuções.
async function getOrCreateCert(certDir) {
  const keyPath = path.join(certDir, 'localhost-key.pem')
  const certPath = path.join(certDir, 'localhost-cert.pem')

  if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    return {
      key: fs.readFileSync(keyPath),
      cert: fs.readFileSync(certPath),
    }
  }

  const pems = await selfsigned.generate(
    [{ name: 'commonName', value: '127.0.0.1' }],
    {
      days: 3650,
      algorithm: 'sha256',
      keySize: 2048,
      extensions: [
        {
          name: 'subjectAltName',
          altNames: [
            { type: 2, value: 'localhost' },
            { type: 7, ip: '127.0.0.1' },
          ],
        },
      ],
    }
  )

  fs.mkdirSync(certDir, { recursive: true })
  fs.writeFileSync(keyPath, pems.private)
  fs.writeFileSync(certPath, pems.cert)

  return { key: pems.private, cert: pems.cert }
}

// Serve o build estático do frontend (SPA com createWebHistory) via HTTPS
// local, já que file:// não suporta a History API usada pelo Vue Router.
async function startStaticServer(rootDir, certDir) {
  const { key, cert } = await getOrCreateCert(certDir)

  const server = https.createServer({ key, cert }, (req, res) => {
    const urlPath = decodeURIComponent(req.url.split('?')[0])
    let filePath = path.join(rootDir, urlPath)

    if (!filePath.startsWith(rootDir)) {
      res.writeHead(403)
      res.end()
      return
    }

    fs.stat(filePath, (err, stats) => {
      if (err || !stats.isFile()) {
        // Só cai no index.html (SPA) para rotas de página, isto é, sem
        // extensão de arquivo. Um asset com hash não encontrado (ex: chunk
        // de um build anterior em cache do PWA) deve retornar 404 de verdade,
        // nunca HTML — senão o browser recusa o module script por MIME type.
        if (path.extname(urlPath)) {
          res.writeHead(404)
          res.end()
          return
        }
        filePath = path.join(rootDir, 'index.html')
      }

      const ext = path.extname(filePath).toLowerCase()
      const contentType = MIME_TYPES[ext] || 'application/octet-stream'

      fs.readFile(filePath, (readErr, content) => {
        if (readErr) {
          res.writeHead(500)
          res.end('Erro ao carregar arquivo')
          return
        }
        res.writeHead(200, { 'Content-Type': contentType })
        res.end(content)
      })
    })
  })

  return new Promise((resolve, reject) => {
    server.once('error', (err) => {
      if (err.code !== 'EADDRINUSE') return reject(err)

      // Porta preferida ocupada (ex: outra instância já rodando): usa porta livre.
      server.removeAllListeners('error')
      server.on('error', reject)
      server.listen(0, '127.0.0.1', () => {
        const { port } = server.address()
        resolve({ server, port })
      })
    })

    server.listen(PREFERRED_PORT, '127.0.0.1', () => {
      resolve({ server, port: PREFERRED_PORT })
    })
  })
}

module.exports = { startStaticServer }
