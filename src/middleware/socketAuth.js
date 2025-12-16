import jwt from 'jsonwebtoken'
import jwksClient from 'jwks-rsa'

// Variables de entorno (se cargan cuando se importa el módulo)
const AWS_REGION = process.env.AWS_REGION || 'us-east-1'
let COGNITO_USER_POOL_ID = process.env.COGNITO_USER_POOL_ID
let client = null

// Función para obtener o crear el cliente JWKS
function getJwksClient() {
  if (!client) {
    COGNITO_USER_POOL_ID = process.env.COGNITO_USER_POOL_ID || COGNITO_USER_POOL_ID
    
    if (!COGNITO_USER_POOL_ID) {
      throw new Error('COGNITO_USER_POOL_ID no está configurado en las variables de entorno')
    }

    // Configura el cliente JWKS para obtener las claves públicas de Cognito
    client = jwksClient({
      jwksUri: `https://cognito-idp.${AWS_REGION}.amazonaws.com/${COGNITO_USER_POOL_ID}/.well-known/jwks.json`,
      cache: true,
      cacheMaxAge: 86400000, // 24 horas
      rateLimit: true,
      jwksRequestsPerMinute: 10
    })
  }
  
  return client
}

function getKey(header, callback) {
  const jwksClientInstance = getJwksClient()
  jwksClientInstance.getSigningKey(header.kid, (err, key) => {
    if (err) {
      return callback(err)
    }
    const signingKey = key.publicKey || key.rsaPublicKey
    callback(null, signingKey)
  })
}

/**
 * Middleware para autenticar conexiones Socket.IO usando Cognito
 */
export function socketAuthMiddleware() {
  return async (socket, next) => {
    try {
      // Obtener el token del handshake
      const token = socket.handshake.auth?.token || 
                   socket.handshake.headers?.authorization?.replace('Bearer ', '') ||
                   socket.handshake.query?.token

      if (!token) {
        return next(new Error('Authentication error: No token provided'))
      }

      // Obtener COGNITO_USER_POOL_ID (puede estar disponible ahora)
      const cognitoUserPoolId = process.env.COGNITO_USER_POOL_ID || COGNITO_USER_POOL_ID
      
      if (!cognitoUserPoolId) {
        console.error('COGNITO_USER_POOL_ID no configurado')
        return next(new Error('Authentication error: Server configuration error'))
      }

      // Verificar el token JWT de Cognito
      jwt.verify(token, getKey, {
        algorithms: ['RS256'],
        issuer: `https://cognito-idp.${AWS_REGION}.amazonaws.com/${cognitoUserPoolId}`
      }, (err, decoded) => {
        if (err) {
          console.error('Token verification error:', err.message)
          return next(new Error('Authentication error: Invalid token'))
        }

        // Extraer información del usuario del token
        // En Cognito, los grupos pueden venir como 'cognito:groups' o en el token_use
        const userGroups = decoded['cognito:groups'] || []
        const tokenUse = decoded.token_use
        
        // Determinar el rol del usuario
        let userRole = null
        if (userGroups.includes('operations')) {
          userRole = 'operations'
        } else if (userGroups.includes('influencer')) {
          userRole = 'influencer'
        } else {
          // Si no hay grupos, verificar claims personalizados o usar el sub
          // Por ahora rechazamos si no tiene rol claro
          return next(new Error('Authentication error: Invalid user role. User must belong to "influencer" or "operations" group'))
        }

        // Extraer id_influencer_main para influencers (si existe)
        const idInfluencerMain = decoded['custom:id_influencer_main']

        // Agregar información del usuario al socket
        socket.user = {
          sub: decoded.sub, // User ID de Cognito
          email: decoded.email || decoded['cognito:username'],
          role: userRole,
          username: decoded['cognito:username'] || decoded.username || decoded.email,
          id_influencer_main: idInfluencerMain // Para influencers, este es el ID que se compara con id_influencer en enrollments
        }

        next()
      })
    } catch (error) {
      console.error('Authentication middleware error:', error)
      next(new Error('Authentication error: ' + error.message))
    }
  }
}

