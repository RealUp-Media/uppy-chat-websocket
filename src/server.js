// IMPORTANTE: Cargar dotenv PRIMERO antes de cualquier otra importación
// que pueda depender de variables de entorno
import { config } from 'dotenv'
config({ override: true })

import express from 'express'
import http from 'http'
import { initSocket } from './socket.js'
import cors from 'cors'

const app = express()
const server = http.createServer(app)

app.use(cors())
app.use(express.json())
app.use(express.static('public'))

app.get('/health', (_, res) => {
  res.json({ status: 'ok' })
})

initSocket(server)

const PORT = process.env.PORT || 3000
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`)
})

// Manejar señales de cierre correctamente (importante para Railway)
process.on('SIGTERM', () => {
  console.log('SIGTERM signal received: closing HTTP server')
  server.close(() => {
    console.log('HTTP server closed')
    process.exit(0)
  })
})

process.on('SIGINT', () => {
  console.log('SIGINT signal received: closing HTTP server')
  server.close(() => {
    console.log('HTTP server closed')
    process.exit(0)
  })
})