/**
 * Compile-time checks that the SDK's response types describe what the control
 * plane sends.
 *
 * `@intutic/shared-types` holds a zod schema for each response a route
 * declares (`src/responses/`), and the control plane's tests hold every route
 * that declares one to its schema with real requests. The SDK keeps its own
 * hand-written types so it stays dependency-free and its reference reads as
 * plain interfaces; the modules here pin each one to the schema it unwraps.
 * `conforms<SdkType>()<Wire>()` compiles only when every field the SDK type
 * names, at any depth, is a field the response carries, with a type it
 * admits. An SDK field the handler never sends (optional or not), or sends
 * with another type, fails `pnpm typecheck`, and the error names the field's
 * path. The SDK may name fewer fields than the response carries.
 *
 * Run by `tsc -p tsconfig.test.json` (the package's `typecheck` script).
 *
 * @module
 */

/** The keys a type spells out, without its index signature. */
type KnownKeys<T> = keyof { [K in keyof T as string extends K ? never : number extends K ? never : K]: T[K] }
/** Every key of any member of a union. */
type AllKeys<T> = T extends unknown ? keyof T : never
type ValueAt<T, K> = T extends unknown ? (K extends keyof T ? T[K] : never) : never
type Element<T> = T extends ReadonlyArray<infer E> ? E : never

/**
 * Paths of the fields `Sdk` names that `Wire` never carries (`never` when
 * there are none). An open wire type (`unknown`, a record) carries anything.
 */
export type Unsent<Sdk, Wire, Path extends string = ''> = unknown extends Wire
  ? never
  : Sdk extends ReadonlyArray<infer E>
    ? Unsent<E, Element<NonNullable<Wire>>, `${Path}[]`>
    : Sdk extends (...args: never[]) => unknown
      ? never
      : Sdk extends object
        ? {
            [K in KnownKeys<Sdk> & string]: string extends AllKeys<NonNullable<Wire>>
              ? never
              : K extends AllKeys<NonNullable<Wire>>
                ? Unsent<NonNullable<Sdk[K]>, NonNullable<ValueAt<NonNullable<Wire>, K>>, `${Path}.${K}`>
                : `${Path}.${K}`
          }[KnownKeys<Sdk> & string]
        : never

/**
 * `conforms<Sdk>()<Wire>()`: compiles when the wire type is assignable to the
 * SDK type and the SDK type names no field the wire type lacks.
 */
export const conforms =
  <Sdk>() =>
  <Wire extends Sdk>(..._unsent: [Unsent<Sdk, Wire>] extends [never] ? [] : [unsent: Unsent<Sdk, Wire>]): void =>
    undefined

/** The rows of a list response, for an SDK method that unwraps `body[key]`. */
export type Rows<Body, Key extends keyof Body> = Body[Key] extends ReadonlyArray<infer Row> ? Row : never
