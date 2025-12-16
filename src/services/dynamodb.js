import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb'

// Configuración del cliente DynamoDB
// AWS SDK v3 automáticamente busca credenciales en este orden:
// 1. Variables de entorno: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY
// 2. Archivo ~/.aws/credentials
// 3. IAM Role (si se ejecuta en EC2/Lambda)
// 4. Credenciales temporales (STS)
//
// NO es necesario pasar credentials explícitamente si están en variables de entorno
// El SDK las detectará automáticamente
const client = new DynamoDBClient({
  region: process.env.AWS_REGION || 'us-east-1'
  // No pasamos credentials aquí - el SDK las lee automáticamente de process.env
})

// Verificar que las credenciales estén disponibles (solo para logging/debugging)
if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
  console.log('✅ Variables de entorno AWS encontradas. El SDK las usará automáticamente.')
} else {
  console.warn('⚠️  AWS_ACCESS_KEY_ID o AWS_SECRET_ACCESS_KEY no encontrados en variables de entorno.')
  console.warn('⚠️  El SDK intentará usar credenciales de ~/.aws/credentials o IAM Role')
}

export const dynamoDB = DynamoDBDocumentClient.from(client)

// Exportar comandos para uso directo si es necesario
export { GetCommand, PutCommand, QueryCommand, ScanCommand }

