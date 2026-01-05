import jwt from 'jsonwebtoken'
import jwksClient from 'jwks-rsa'

// Variables de entorno (se leen dinámicamente para soportar dotenv)
const AWS_REGION = process.env.AWS_REGION || 'us-east-1'

/**
 * Obtiene la configuración de user pools leyendo las variables de entorno dinámicamente
 * Esto permite que dotenv cargue las variables antes de que se lean
 * @returns {object} Objeto con los user pools configurados
 */
function getUserPoolsConfig() {
  return {
    influencers: process.env.COGNITO_USER_POOL_ID_INFLUENCERS || null,
    operations: process.env.COGNITO_USER_POOL_ID_OPERATIONS || null,
    default: process.env.COGNITO_USER_POOL_ID || null
  }
}

// Cache de clientes JWKS por user pool
const jwksClients = new Map()

/**
 * Obtiene o crea un cliente JWKS para un user pool específico
 * @param {string} userPoolId - ID del user pool de Cognito
 * @returns {jwksClient} Cliente JWKS configurado
 */
function getJwksClient(userPoolId) {
  if (!userPoolId) {
    throw new Error('User Pool ID es requerido')
  }

  // Si ya existe un cliente para este user pool, retornarlo
  if (jwksClients.has(userPoolId)) {
    return jwksClients.get(userPoolId)
  }

  const jwksUri = `https://cognito-idp.${AWS_REGION}.amazonaws.com/${userPoolId}/.well-known/jwks.json`

  // Configura el cliente JWKS para obtener las claves públicas de Cognito
  const client = jwksClient({
    jwksUri: jwksUri,
    cache: true,
    cacheMaxAge: 86400000, // 24 horas
    rateLimit: true,
    jwksRequestsPerMinute: 10,
    requestHeaders: {}, // Headers adicionales si es necesario
    timeout: 30000 // 30 segundos timeout
  })

  // Guardar en cache
  jwksClients.set(userPoolId, client)
  
  return client
}

/**
 * Obtiene la clave de firma para un user pool específico
 * @param {string} userPoolId - ID del user pool
 * @param {object} header - Header del JWT
 * @param {function} callback - Callback con (error, signingKey)
 */
function getKey(userPoolId, header, callback) {
  try {
    const jwksClientInstance = getJwksClient(userPoolId)
    
    if (!header || !header.kid) {
      return callback(new Error('Token header missing kid (key ID)'))
    }
    
    jwksClientInstance.getSigningKey(header.kid, (err, key) => {
      if (err) {
        return callback(err)
      }
      
      if (!key) {
        return callback(new Error(`No se encontró la clave de firma para kid: ${header.kid}`))
      }
      
      const signingKey = key.publicKey || key.rsaPublicKey
      if (!signingKey) {
        return callback(new Error('La clave obtenida no tiene publicKey ni rsaPublicKey'))
      }
      
      callback(null, signingKey)
    })
  } catch (error) {
    callback(error)
  }
}

/**
 * Obtiene la lista de user pools configurados
 * Lee las variables de entorno dinámicamente cada vez que se llama
 * @returns {Array<{id: string, type: string}>} Lista de user pools con su tipo
 */
function getConfiguredUserPools() {
  const userPools = getUserPoolsConfig()
  const pools = []
  
  // Agregar user pools específicos si están configurados
  if (userPools.influencers) {
    pools.push({ id: userPools.influencers, type: 'influencers' })
  }
  
  if (userPools.operations) {
    pools.push({ id: userPools.operations, type: 'operations' })
  }
  
  // Si no hay pools específicos pero hay uno por defecto, usarlo
  if (pools.length === 0 && userPools.default) {
    pools.push({ id: userPools.default, type: 'default' })
  }
  
  return pools
}

/**
 * Verifica un token JWT con un user pool específico
 * @param {string} token - Token JWT a verificar
 * @param {string} userPoolId - ID del user pool
 * @returns {Promise<object>} Token decodificado si es válido
 */
function verifyTokenWithUserPool(token, userPoolId) {
  return new Promise((resolve, reject) => {
    try {
      const expectedIssuer = `https://cognito-idp.${AWS_REGION}.amazonaws.com/${userPoolId}`
      
      // Decodificar el header primero para obtener el kid
      const decodedHeader = jwt.decode(token, { complete: true })
      if (!decodedHeader || !decodedHeader.header) {
        return reject(new Error('Token inválido: no se puede decodificar el header'))
      }

      // Crear función getKey específica para este user pool
      const getKeyForPool = (header, callback) => {
        getKey(userPoolId, header, callback)
      }
      
      jwt.verify(token, getKeyForPool, {
        algorithms: ['RS256'],
        issuer: expectedIssuer
      }, (err, decoded) => {
        if (err) {
          reject(err)
        } else {
          resolve(decoded)
        }
      })
    } catch (error) {
      reject(error)
    }
  })
}

/**
 * Middleware para autenticar conexiones Socket.IO usando Cognito
 * 
 * Soporta múltiples user pools:
 * - COGNITO_USER_POOL_ID_INFLUENCERS: User pool para influencers
 * - COGNITO_USER_POOL_ID_OPERATIONS: User pool para operations
 * - COGNITO_USER_POOL_ID: User pool por defecto (compatibilidad con configuración anterior)
 * 
 * Para deshabilitar temporalmente la autenticación, establece:
 * DISABLE_AUTH=true en las variables de entorno
 */
export function socketAuthMiddleware() {
  return async (socket, next) => {
    try {
      // Verificar si la autenticación está deshabilitada (para pruebas)
      const disableAuth = process.env.DISABLE_AUTH === 'true' || process.env.DISABLE_AUTH === '1'
      
      if (disableAuth) {
        // Crear un usuario de prueba
        socket.user = {
          sub: 'test-user-' + socket.id,
          email: 'test@example.com',
          role: 'operations',
          username: 'test-user',
          id_influencer_main: null
        }
        return next()
      }

      // Obtener el token del handshake
      const token = socket.handshake.auth?.token || 
                   socket.handshake.headers?.authorization?.replace('Bearer ', '') ||
                   socket.handshake.query?.token

      if (!token) {
        return next(new Error('Authentication error: No token provided'))
      }

      // Obtener lista de user pools configurados
      const configuredPools = getConfiguredUserPools()
      
      if (configuredPools.length === 0) {
        console.error('❌ No hay user pools configurados. Configura al menos uno de:')
        console.error('   - COGNITO_USER_POOL_ID')
        console.error('   - COGNITO_USER_POOL_ID_INFLUENCERS')
        console.error('   - COGNITO_USER_POOL_ID_OPERATIONS')
        return next(new Error('Authentication error: Server configuration error - No user pools configured'))
      }

      // Intentar verificar el token con cada user pool hasta encontrar uno válido
      let decoded = null
      let verifiedUserPool = null
      let lastError = null

      for (const pool of configuredPools) {
        try {
          decoded = await verifyTokenWithUserPool(token, pool.id)
          verifiedUserPool = pool
          break // Token válido encontrado, salir del loop
        } catch (error) {
          lastError = error
          // Continuar con el siguiente user pool
          continue
        }
      }

      // Si no se pudo verificar con ningún user pool
      if (!decoded || !verifiedUserPool) {
        console.error('Token verification error:', lastError?.message || 'Token inválido para todos los user pools')
        return next(new Error('Authentication error: Invalid token'))
      }

      // Extraer información del usuario del token
      const userGroups = decoded['cognito:groups'] || []
      
      // Determinar el rol del usuario
      // Si el user pool es específico (influencers/operations), usar ese rol
      // Si no, intentar determinar el rol desde los grupos del token
      let userRole = null
      
      if (verifiedUserPool.type === 'influencers') {
        userRole = 'influencer'
      } else if (verifiedUserPool.type === 'operations') {
        userRole = 'operations'
      } else {
        // User pool por defecto: determinar rol desde grupos
        if (userGroups.includes('operations')) {
          userRole = 'operations'
        } else if (userGroups.includes('influencer')) {
          userRole = 'influencer'
        } else {
          // Si no hay grupos, rechazar
          return next(new Error('Authentication error: Invalid user role. User must belong to "influencer" or "operations" group'))
        }
      }

      // Extraer id_influencer_main para influencers (si existe)
      const idInfluencerMain = decoded['custom:id_influencer_main']

      // Agregar información del usuario al socket
      socket.user = {
        sub: decoded.sub,
        email: decoded.email || decoded['cognito:username'],
        role: userRole,
        username: decoded['cognito:username'] || decoded.username || decoded.email,
        id_influencer_main: idInfluencerMain,
        userPoolId: verifiedUserPool.id, // Guardar el user pool que validó el token
        userPoolType: verifiedUserPool.type
      }

      console.log(`✅ Usuario autenticado: ${socket.user.username} (${userRole}) desde user pool: ${verifiedUserPool.id}`)

      next()
    } catch (error) {
      console.error('Authentication middleware error:', error)
      next(new Error('Authentication error: ' + error.message))
    }
  }
}

