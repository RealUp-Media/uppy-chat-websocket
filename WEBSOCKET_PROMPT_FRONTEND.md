# Prompt para Frontend Developer

## Implementar Cliente WebSocket para Chat

Necesito implementar un cliente WebSocket que permita comunicación en tiempo real entre influencers y operadores basado en `enrollment_id`.

### Requisitos:

1. **Conexión**: Conectar a `ws://localhost:3000` usando Socket.IO client
2. **Autenticación**: Enviar token JWT de AWS Cognito en el handshake
   ```javascript
   io('ws://localhost:3000', {
     auth: { token: 'tu-jwt-token-de-cognito' }
   })
   ```

### Eventos que DEBO ENVIAR al servidor:

1. **`join_conversation`** - Unirse a una conversación
   ```javascript
   socket.emit('join_conversation', {
     enrollment_id: "9b7a28d8-ebae-44a7-b386-1894ba32357d"
   })
   ```

2. **`leave_conversation`** - Salir de una conversación
   ```javascript
   socket.emit('leave_conversation', {
     enrollment_id: "9b7a28d8-ebae-44a7-b386-1894ba32357d"
   })
   ```

3. **`send_message`** - Enviar un mensaje
   ```javascript
   socket.emit('send_message', {
     enrollment_id: "9b7a28d8-ebae-44a7-b386-1894ba32357d",
     message_text: "Hola, este es mi mensaje"
   })
   ```

### Eventos que RECIBO del servidor:

1. **`authenticated`** - Confirmación de autenticación exitosa
   ```javascript
   {
     user: {
       id: "64582498-9091-7029-1d34-45797ea85e5b",
       email: "user@example.com",
       role: "influencer" | "operations",
       username: "usuario123"
     }
   }
   ```

2. **`joined_conversation`** - Confirmación de unirse a conversación
   ```javascript
   { enrollment_id: "9b7a28d8-ebae-44a7-b386-1894ba32357d" }
   ```

3. **`conversation_history`** - Historial de mensajes (se envía al unirse)
   ```javascript
   {
     enrollment_id: "9b7a28d8-ebae-44a7-b386-1894ba32357d",
     messages: [
       {
         message_id: "uuid",
         conversation_id: "enrollment_id",
         sender_id: "user-sub",
         sender_type: "influencer" | "operations",
         sender_username: "usuario123",
         message_text: "Texto del mensaje",
         created_at: "2025-12-15T10:30:00.000Z"
       }
     ]
   }
   ```

4. **`new_message`** - Nuevo mensaje en tiempo real
   ```javascript
   {
     message_id: "uuid",
     conversation_id: "enrollment_id",
     sender_id: "user-sub",
     sender_type: "influencer" | "operations",
     sender_username: "usuario123",
     message_text: "Texto del mensaje",
     created_at: "2025-12-15T10:30:00.000Z"
   }
   ```

5. **`user_joined`** - Otro usuario se unió a la conversación
   ```javascript
   {
     user: {
       id: "user-sub",
       username: "usuario123",
       role: "influencer" | "operations"
     },
     enrollment_id: "9b7a28d8-ebae-44a7-b386-1894ba32357d"
   }
   ```

6. **`left_conversation`** - Confirmación de salir de conversación
   ```javascript
   { enrollment_id: "9b7a28d8-ebae-44a7-b386-1894ba32357d" }
   ```

7. **`error`** - Error en cualquier operación
   ```javascript
   { message: "Descripción del error" }
   ```

### Flujo de uso:

1. Conectar con token JWT de Cognito
2. Escuchar `authenticated` para confirmar conexión
3. Enviar `join_conversation` con el `enrollment_id`
4. Recibir `conversation_history` con los mensajes existentes
5. Escuchar `new_message` para mensajes en tiempo real
6. Enviar `send_message` para escribir mensajes
7. Enviar `leave_conversation` cuando se cierra el chat

### Restricciones:

- Los **influencers** solo pueden acceder a enrollments donde `id_influencer` coincide con su `custom:id_influencer_main` del token
- Los **operadores** pueden acceder a cualquier conversación
- Debes unirte a la conversación antes de enviar mensajes

### Instalación:

```bash
npm install socket.io-client
```


