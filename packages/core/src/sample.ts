/**
 * The landing page's sample schema, to see Loutre in action with nothing at hand.
 * The API embeds its vocabulary (apps/api/src/presets.ts), so trying it costs no AI call.
 * Changing this text makes the API's `ai.test.ts` demand a new fingerprint.
 */
export const SAMPLE_SPEC = `openapi: 3.1.0
info:
  title: boutique-api
  version: 1.0.0
paths:
  /users:
    get:
      summary: Liste des clients
      responses:
        '200':
          description: OK
          content:
            application/json:
              schema:
                type: array
                items:
                  $ref: '#/components/schemas/User'
  /users/{id}:
    get:
      summary: Un client
      parameters:
        - name: id
          in: path
          required: true
          schema:
            type: string
      responses:
        '200':
          description: OK
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/User'
        '404':
          description: Introuvable
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Error'
  /orders:
    get:
      summary: Commandes
      responses:
        '200':
          description: OK
          content:
            application/json:
              schema:
                type: array
                items:
                  $ref: '#/components/schemas/Order'
    post:
      summary: Passer une commande
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/Order'
      responses:
        '201':
          description: Créée
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Order'
components:
  schemas:
    User:
      type: object
      required: [id, name, email]
      properties:
        id:
          type: string
        name:
          type: string
        email:
          type: string
          format: email
        phone:
          type: string
        city:
          type: string
        plan:
          type: string
          enum: [free, pro]
        created_at:
          type: string
          format: date-time
        updated_at:
          type: string
          format: date-time
    Order:
      type: object
      required: [id, customer, items, total, status]
      properties:
        id:
          type: string
        customer:
          $ref: '#/components/schemas/User'
        items:
          type: array
          minItems: 1
          items:
            type: object
            properties:
              product_name:
                type: string
              unit_price:
                type: number
              quantity:
                type: integer
                minimum: 1
        subtotal:
          type: number
        tax:
          type: number
        total:
          type: number
        status:
          type: string
          enum: [pending, paid, shipped, delivered]
        siret:
          type: string
        created_at:
          type: string
          format: date-time
    Error:
      type: object
      properties:
        code:
          type: integer
        message:
          type: string
`

/**
 * The same sample as TypeScript types: what a front-end dev pastes when they have no
 * OpenAPI schema. Its vocabulary is embedded too (API presets).
 */
export const SAMPLE_TYPES = `/** @title boutique-ts */

export interface User {
  id: string
  name: string
  email: string
  phone?: string
  city: string
  plan: "free" | "pro"
  createdAt: Date
  updatedAt: Date
}

export interface Order {
  id: string
  customer: User
  items: OrderLine[]
  status: "pending" | "paid" | "shipped" | "delivered"
  subtotal: number
  tax: number
  total: number
  siret: string
  createdAt: Date
}

export interface OrderLine {
  productName: string
  unitPrice: number
  quantity: number
}
`
