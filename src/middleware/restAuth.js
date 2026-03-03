import jwt from 'jsonwebtoken'
import jwksClient from 'jwks-rsa'

// Variables de entorno
const AWS_REGION = process.env.AWS_REGION || 'us-east-1'

/**
 * Obtiene la configuración de user pools leyendo las variables de entorno dinámicamente
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

function getJwksClient(userPoolId) {
  if (!jwksClients.has(userPoolId)) {
    const client = jwksClient({
      jwksUri: `https://cognito-idp.${AWS_REGION}.amazonaws.com/${userPoolId}/.well-known/jwks.json`,
      cache: true,
      cacheMaxAge: 86400000 // 24 horas
    })
    jwksClients.set(userPoolId, client)
  }
  return jwksClients.get(userPoolId)
}

function getKey(userPoolId, header, callback) {
  const client = getJwksClient(userPoolId)
  client.getSigningKey(header.kid, (err, key) => {
    if (err) {
      return callback(err)
    }
    const signingKey = key.getPublicKey()
    callback(null, signingKey)
  })
}

function getConfiguredUserPools() {
  const config = getUserPoolsConfig()
  const pools = []
  
  if (config.influencers) {
    pools.push({ id: config.influencers, type: 'influencers' })
  }
  if (config.operations) {
    pools.push({ id: config.operations, type: 'operations' })
  }
  if (config.default) {
    pools.push({ id: config.default, type: 'default' })
  }
  
  return pools
}

/**
 * Verifica un token JWT con un user pool específico
 */
function verifyTokenWithUserPool(token, userPoolId) {
  return new Promise((resolve, reject) => {
    try {
      const expectedIssuer = `https://cognito-idp.${AWS_REGION}.amazonaws.com/${userPoolId}`
      
      const decodedHeader = jwt.decode(token, { complete: true })
      if (!decodedHeader || !decodedHeader.header) {
        return reject(new Error('Token inválido: no se puede decodificar el header'))
      }

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
 * Middleware de autenticación para rutas REST usando Cognito
 * 
 * Para deshabilitar temporalmente la autenticación, establece:
 * DISABLE_AUTH=true en las variables de entorno
 */
export function restAuthMiddleware() {
  return async (req, res, next) => {
    try {
      // Verificar si la autenticación está deshabilitada (para pruebas)
      const disableAuth = process.env.DISABLE_AUTH === 'true' || process.env.DISABLE_AUTH === '1'
      
      if (disableAuth) {
        // Crear un usuario de prueba
        req.user = {
          sub: 'test-user-rest',
          email: 'test@example.com',
          role: 'operations',
          username: 'test-user',
          id_influencer_main: null
        }
        return next()
      }

      // Obtener el token del header Authorization
      const authHeader = req.headers.authorization
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ 
          error: 'Authentication error', 
          message: 'No token provided. Use Authorization: Bearer <token>' 
        })
      }

      const token = authHeader.replace('Bearer ', '')

      // Obtener lista de user pools configurados
      const configuredPools = getConfiguredUserPools()
      
      if (configuredPools.length === 0) {
        console.error('❌ No hay user pools configurados.')
        return res.status(500).json({ 
          error: 'Server configuration error', 
          message: 'No user pools configured' 
        })
      }

      // Intentar verificar el token con cada user pool hasta encontrar uno válido
      let decoded = null
      let verifiedUserPool = null
      let lastError = null

      for (const pool of configuredPools) {
        try {
          decoded = await verifyTokenWithUserPool(token, pool.id)
          verifiedUserPool = pool
          break
        } catch (error) {
          lastError = error
          continue
        }
      }

      // Si no se pudo verificar con ningún user pool
      if (!decoded || !verifiedUserPool) {
        console.error('Token verification error:', lastError?.message || 'Token inválido')
        return res.status(401).json({ 
          error: 'Authentication error', 
          message: 'Invalid token' 
        })
      }

      // Extraer información del usuario del token
      const userGroups = decoded['cognito:groups'] || []
      
      // Determinar el rol del usuario
      let userRole = null
      
      if (verifiedUserPool.type === 'influencers') {
        userRole = 'influencer'
      } else if (verifiedUserPool.type === 'operations') {
        userRole = 'operations'
      } else {
        if (userGroups.includes('operations')) {
          userRole = 'operations'
        } else if (userGroups.includes('influencer')) {
          userRole = 'influencer'
        } else {
          return res.status(403).json({ 
            error: 'Authorization error', 
            message: 'Invalid user role. User must belong to "influencer" or "operations" group' 
          })
        }
      }

      // Extraer id_influencer_main para influencers
      const idInfluencerMain = decoded['custom:id_influencer_main']

      // Agregar información del usuario al request
      req.user = {
        sub: decoded.sub,
        email: decoded.email,
        role: userRole,
        username: decoded['cognito:username'] || decoded.username || decoded.email,
        id_influencer_main: idInfluencerMain
      }

      next()
    } catch (error) {
      console.error('Error en middleware de autenticación:', error)
      return res.status(500).json({ 
        error: 'Authentication error', 
        message: 'Internal server error during authentication' 
      })
    }
  }
}
