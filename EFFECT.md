# Building maintainable Effect applications

A reusable engineering guide for TypeScript applications built with Effect v4,
Node, HTTP APIs, React, and Effect Atom.

This document describes application structure and correctness conventions. It is
not a product architecture. Copy or reference it from a repository's
`AGENTS.md`, then add product-specific rules separately.

> Effect v4 APIs used here may live under `effect/unstable/*`. Pin compatible
> Effect packages to the same exact version and verify APIs when upgrading.

## Core laws

1. **Use Effect for control flow and platform integration.** Application methods
   return `Effect`; they do not expose raw `Promise` values.
2. **Decode at every external boundary.** Files, environment values, CLI input,
   HTTP data, database rows, SDK payloads, and URL values begin as `unknown`.
3. **Make illegal states unrepresentable.** Prefer branded values, literal
   unions, tagged unions, and `Option` over casts and optional-field bags.
4. **Expected failures are typed values.** Use yieldable
   `Schema.TaggedErrorClass` failures, not generic `Error`, `throw`, or
   JavaScript `try`/`catch`.
5. **Capture dependencies in layers.** Service methods should not leak platform
   requirements into consumer environments.
6. **Composition over inheritance.** Classes are acceptable for Effect service
   tags and schema-backed tagged errors, not for domain class hierarchies.
7. **One contract drives every transport.** Shared schemas define HTTP server
   handlers, inferred clients, OpenAPI, stream payloads, and errors.
8. **React renders reactive state.** Effect Atom owns frontend effects, caching,
   mutation state, streams, cancellation, and refresh dependencies.
9. **Strictness is a design tool.** Do not weaken TypeScript to make an invalid
   design compile.
10. **Test behavior through production boundaries.** Use real schemas, layers,
    disposable resources, and generated clients rather than reimplementing
    production logic in tests.

## Package and version policy

- Use ESM: `"type": "module"`.
- Require a current Node version explicitly.
- Pin `effect`, `@effect/*`, and `@effect/vitest` to the same exact release.
- Prefer exact versions for foundational runtime packages. Upgrade them as one
  reviewed change.
- Keep browser-only dependencies out of backend source modules.
- Treat modules under `effect/unstable/*` as version-sensitive boundaries.

A typical package starts with scripts like:

```json
{
  "type": "module",
  "engines": { "node": ">=22" },
  "scripts": {
    "build": "tsc -b src web && vite build",
    "check": "tsc -b",
    "clean": "tsc -b --clean && rm -rf dist dist-test dist-web",
    "test": "vitest run"
  }
}
```

## Imports

Use namespace imports for external modules:

```ts
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Option from "effect/Option"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as React from "react"
```

Use namespace imports for internal concept modules as well:

```ts
import * as Workflow from "./Workflow.js"
import * as WorkflowError from "./WorkflowError.js"
```

Type-only namespace imports are fine:

```ts
import type * as FileSystem from "effect/FileSystem"
```

Do not mix default and named import styles arbitrarily. Namespace imports make
module ownership visible and survive library export changes more predictably.

Use `.js` extensions for relative imports under `NodeNext`:

```ts
import * as Project from "./Project.js"
```

## Module structure

Keep source directories flat until a real boundary earns a subproject.

```text
src/
├── Artifact.ts
├── Workflow.ts
├── WorkflowError.ts
├── Project.ts
├── Process.ts
├── WorkbenchApi.ts
├── Workbench.ts
└── Main.ts

test/
├── Artifact.test.ts
├── Workflow.test.ts
├── WorkflowError.test.ts
├── Project.test.ts
├── Process.test.ts
└── Workbench.test.ts

web/
├── ApiClient.ts
├── ApplicationAtoms.ts
├── App.tsx
├── DomainViews.tsx
├── DomainViews.test.tsx
└── Main.tsx
```

Rules:

- Files use `PascalCase.ts` or `PascalCase.tsx`.
- Each module owns one concept, domain model, adapter, service, or boundary.
- Avoid generic directories such as `utils`, `helpers`, and `common`.
- Extract a named module when behavior has a distinct vocabulary, dependency
  boundary, or independent tests.
- Every `src/Foo.ts` has a corresponding `test/Foo.test.ts`.
- Keep domain schemas separate from operational services when either becomes
  substantial.
- Keep the executable entrypoint trivial.

Comments should explain **why a construct exists**, which boundary it protects,
or which invariant it preserves. Do not paraphrase obvious code.

## TypeScript solution structure

Use separate composite projects for backend source, backend tests, and web code.
The root is a solution file only.

### `tsconfig.base.json`

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true,
    "noPropertyAccessFromIndexSignature": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "allowUnreachableCode": false,
    "allowUnusedLabels": false,
    "useUnknownInCatchVariables": true,
    "verbatimModuleSyntax": true,
    "isolatedModules": true,
    "erasableSyntaxOnly": true,
    "noUncheckedSideEffectImports": true,
    "forceConsistentCasingInFileNames": true,
    "moduleDetection": "force",
    "noEmitOnError": true,
    "sourceMap": true,
    "declaration": true,
    "declarationMap": true,
    "skipLibCheck": true
  }
}
```

### `src/tsconfig.json`

```json
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": {
    "composite": true,
    "rootDir": ".",
    "outDir": "../dist",
    "tsBuildInfoFile": "../dist/.tsbuildinfo"
  },
  "include": ["*.ts"]
}
```

### `test/tsconfig.json`

```json
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": {
    "composite": true,
    "noEmit": true,
    "rootDir": ".",
    "tsBuildInfoFile": "../dist-test/.tsbuildinfo"
  },
  "references": [{ "path": "../src" }],
  "include": ["*.ts"]
}
```

### `web/tsconfig.json`

```json
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": {
    "composite": true,
    "noEmit": true,
    "rootDir": ".",
    "jsx": "react-jsx",
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "types": ["vite/client"],
    "tsBuildInfoFile": "../dist-web/.tsbuildinfo"
  },
  "references": [{ "path": "../src" }],
  "include": ["*.ts", "*.tsx"]
}
```

### Root `tsconfig.json`

```json
{
  "files": [],
  "references": [
    { "path": "./src" },
    { "path": "./web" },
    { "path": "./test" }
  ]
}
```

Do not solve project-reference errors by adding broad include globs or disabling
strict flags. Fix the actual dependency direction.

## Domain schemas

Schemas are executable contracts and the source of domain types.

```ts
import * as Schema from "effect/Schema"

export const UserId = Schema.NonEmptyString.pipe(Schema.brand("UserId"))
export type UserId = typeof UserId.Type

export const User = Schema.Struct({
  id: UserId,
  name: Schema.NonEmptyString,
  status: Schema.Literals(["active", "suspended"])
}).annotate({
  description: "A user returned to generated clients."
})
export type User = typeof User.Type
```

### Brand every identity

Brand identifiers end to end:

- database identity
- aggregate identity
- session identity
- command identity
- request identity
- graph identity
- Git commit or branch values when confusion is dangerous

Do not decode a brand and then weaken it back to `string` in an API, service, or
frontend atom.

### Prefer literal unions

```ts
const Status = Schema.Literals(["pending", "running", "complete"])
```

Do not use `Schema.String` when only a closed vocabulary is valid.

### Prefer tagged unions

Do not model lifecycle variants as a record with mutually dependent optional
fields:

```ts
const Active = Schema.Struct({
  _tag: Schema.Literal("Active"),
  startedAt: Schema.String
})

const Complete = Schema.Struct({
  _tag: Schema.Literal("Complete"),
  startedAt: Schema.String,
  completedAt: Schema.String
})

export const JobState = Schema.Union([Active, Complete])
```

Switch exhaustively on `_tag`.

### Use `Option` for domain absence

Use `Option.Option<A>` instead of `A | undefined | null` in decoded domain
models and service APIs. For optional object keys at serialization boundaries:

```ts
const Request = Schema.Struct({
  cursor: Schema.OptionFromOptionalKey(Cursor)
})
```

Convert to `undefined` only at a platform API that requires it:

```ts
Option.getOrUndefined(value)
```

### Preserve `unknown` at boundaries

Decode instead of asserting:

```ts
const user = yield* Schema.decodeUnknownEffect(User)(input)
```

Avoid:

```ts
const user = input as User
```

A cast can describe a fact already proven by the type system; it must not replace
runtime validation.

## Error design

Expected failures are schema-backed, tagged, yieldable values.

```ts
import * as Schema from "effect/Schema"

export class UserNotFound extends Schema.TaggedErrorClass<UserNotFound>()(
  "UserNotFound",
  {
    userId: UserId,
    message: Schema.String
  }
) {}
```

Yield the error directly:

```ts
if (!user) {
  return yield* new UserNotFound({
    userId,
    message: "user does not exist"
  })
}
```

Rules:

- Do not use `new Error` for domain or expected operational failures.
- Do not `throw` expected failures.
- Do not use JavaScript `try`/`catch` for application control flow.
- Use `Effect.try` for synchronous exception-throwing libraries.
- Use `Effect.tryPromise` for Promise SDKs.
- Map low-level failures into a domain error at the adapter boundary.
- Preserve useful structured fields such as identity, operation, stage, path,
  command, or diagnostic list.
- Callers recover by `_tag`, not by parsing `message`.
- Keep defects distinct from expected failures. Do not catch every defect and
  turn it into vague prose.

Example adapter:

```ts
const decodeYaml = Effect.fnUntraced(function* (
  source: string,
  filename: string
) {
  const value = yield* Effect.try({
    try: (): unknown => YAML.parse(source),
    catch: cause => new SpecificationError({
      source: filename,
      message: String(cause)
    })
  })

  return yield* Schema.decodeUnknownEffect(Document)(value).pipe(
    Effect.mapError(cause => new SpecificationError({
      source: filename,
      message: String(cause)
    }))
  )
})
```

## Effect functions

Use `Effect.fn` for meaningful traced operations:

```ts
const load = Effect.fn("Users.load")(function* (id: UserId) {
  // ...
})
```

Use `Effect.fnUntraced` for small helpers that do not deserve a span:

```ts
const readText = Effect.fnUntraced(function* (path: string) {
  // ...
})
```

Prefer these to anonymous functions returning effects. They preserve useful
names, typing, and tracing conventions.

Use `Effect.gen` for readable sequential workflows. Use combinators where they
make intent clearer, especially `mapError`, `tap`, `all`, `forEach`, `timeout`,
and `ensuring`.

## Services and layers

Operational capabilities are `Context.Service` values backed by memoized
layers.

### Naming

Use plural domain nouns:

- `Projects`
- `Users`
- `TaskRunners`
- `Workbenches`

Do not append `Service` to the tag name. A singular tool name such as `Git` is
fine when the domain term itself is a tool.

### Service shape

```ts
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"

export interface UserOperations {
  readonly load: (
    id: UserId
  ) => Effect.Effect<User, UserNotFound | StorageError>
}

export class Users extends Context.Service<Users, UserOperations>()(
  "application/Users"
) {}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem

  const load: UserOperations["load"] = Effect.fn("Users.load")(
    function* (id) {
      // fs is captured here; callers require only Users.
      return yield* loadUserFromFile(fs, id)
    }
  )

  return Users.of({ load })
})

export const layer: Layer.Layer<Users> = Layer.effect(Users, make).pipe(
  Layer.provide(NodeServices.layer)
)
```

Important properties:

- Define the operation interface explicitly.
- Type implementations through `Operations["method"]` so signatures cannot
  drift.
- Acquire dependencies once in `make`.
- Close over those dependencies in methods.
- Export a layer whose input requirements are already provided where practical.
- Consumers see `Users`, not `FileSystem | Path | Crypto | ...`.
- Compose layers at application boundaries rather than manually constructing
  services repeatedly.

Layers are memoized. Reuse layer values; do not recreate stateful layers inside
every request or method.

### Layer composition

```ts
export const layer = Layer.effect(Workbenches, make).pipe(
  Layer.provide(Layer.mergeAll(
    Projects.layer,
    Drafts.layer,
    NodeServices.layer
  ))
)
```

Use `Layer.provideMerge` only when the provided service also needs to remain in
the output. Be deliberate about what the final layer exposes.

## Platform services

Use Effect platform services instead of direct Node APIs:

- `FileSystem.FileSystem`, not `node:fs`
- `Path.Path`, not `node:path` in ordinary application code
- `Crypto.Crypto`, not ad hoc random or hashing calls
- Effect process/spawner APIs, not raw `child_process`
- Effect HTTP server/client modules, not untyped fetch wrappers

Platform-specific imports belong in adapters and entrypoints. Domain modules
should not know they run on Node.

### Resource safety

Use `Effect.scoped` and scoped constructors for files, processes, servers,
subscriptions, and temporary directories.

```ts
const program = Effect.scoped(
  Effect.gen(function* () {
    const directory = yield* fs.makeTempDirectoryScoped()
    // directory is removed when the scope closes
  })
)
```

Use `Effect.acquireRelease` or `Effect.addFinalizer` for SDK resources that do
not provide Effect-native scoped constructors.

Interruption should work by default. Restrict uninterruptibility to the smallest
critical section needed to preserve an invariant, such as an atomic metadata
commit. Never make an entire long-running workflow uninterruptible merely to
avoid handling cancellation.

### Promise SDKs

Wrap Promise boundaries once in an adapter:

```ts
const invoke = Effect.fn("Vendor.invoke")((request: Request) =>
  Effect.tryPromise({
    try: () => vendor.invoke(request),
    catch: cause => new VendorError({
      operation: "invoke",
      message: String(cause)
    })
  })
)
```

Do not let raw Promises escape into domain services or React components.

## Persistence and files

- Decode every file after parsing.
- Encode domain values through their schema before persistence.
- Retain source path in decoding errors.
- Sort directory entries before loading to keep behavior deterministic.
- Detect duplicate identities explicitly.
- Write atomically when partial state would be dangerous: write a temporary
  sibling, then rename.
- Keep generated runtime state separate from authored declarative data.
- Use scoped disposable directories in tests.

Do not use a database to duplicate an authoritative external log or event store.
Store only indexes, coordination state, or metadata that the authoritative
source does not already provide.

## Executable boundary

Keep `Main.ts` tiny:

```ts
#!/usr/bin/env node

import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"

import * as Cli from "./Cli.js"
import * as Application from "./Application.js"

const main = Cli.runWith(process.argv.slice(2)).pipe(
  Effect.provide(Layer.mergeAll(
    Application.layer,
    NodeServices.layer
  ))
)

NodeRuntime.runMain(main)
```

The entrypoint may read `process.argv` and select platform layers. Business
logic, decoding, and error mapping live elsewhere.

## HTTP API design

Define one shared `HttpApi` in backend source. It is the transport contract for
both server and browser.

### Contract rules

- Request params, query, headers, and payloads are schemas.
- Success responses are schemas.
- Every declared failure is a schema-backed tagged error.
- Add client-relevant documentation with schema `description` annotations.
- Put HTTP status metadata directly on domain API errors.
- Do not create redundant `FooResponse` schemas that merely duplicate the
  domain value.
- Re-export canonical branded identities rather than redefining weaker browser
  versions.
- Use SSE schemas for typed streams.

```ts
export class RequestError extends Schema.TaggedErrorClass<RequestError>()(
  "RequestError",
  { message: Schema.String },
  { httpApiStatus: 400 }
) {}

export class UserNotFound extends Schema.TaggedErrorClass<UserNotFound>()(
  "UserNotFound",
  {
    userId: UserId,
    message: Schema.String
  },
  { httpApiStatus: 404 }
) {}
```

Group endpoints by stable domain capability:

```ts
const UsersApi = HttpApiGroup.make("users")
  .add(HttpApiEndpoint.get("get", "/api/users/:userId", {
    params: Schema.Struct({ userId: UserId }),
    success: User,
    error: [UserNotFound]
  }))

export const api = HttpApi.make("ApplicationApi").add(UsersApi)
```

### Server handlers

Handlers should decode through the API automatically and delegate immediately
to application services:

```ts
export function apiLayer() {
  return HttpApiBuilder.group(
    Api.api,
    "users",
    Effect.fnUntraced(function* (handlers) {
      const users = yield* Users
      return handlers.handle("get", request =>
        users.load(request.params.userId))
    })
  ).pipe(Layer.provide(Users.layer))
}
```

Do not repeat schema validation or business logic in handlers.

### Streams

Use `HttpApiSchema.StreamSse` for typed server-sent event payloads and typed
stream errors. Persist durable history elsewhere; streams should carry live,
ephemeral activity rather than becoming an accidental database.

## Frontend architecture with Effect Atom

React components should subscribe to reactive values and write user intent.
They should not manually run or supervise Effect fibers.

### Registry root

```tsx
import * as AtomReact from "@effect/atom-react"
import * as React from "react"
import * as ReactDom from "react-dom/client"

ReactDom.createRoot(root).render(
  <React.StrictMode>
    <AtomReact.RegistryProvider>
      <App />
    </AtomReact.RegistryProvider>
  </React.StrictMode>
)
```

The registry owns atom subscriptions, caching, cancellation, stream lifetimes,
and idle cleanup.

### Native HttpApi integration

Use `AtomHttpApi.Service`; do not add a separate `ManagedRuntime` merely to run
HTTP requests.

```ts
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import * as AtomHttpApi from "effect/unstable/reactivity/AtomHttpApi"

export class ApplicationClient extends AtomHttpApi.Service<ApplicationClient>()(
  "application/web/ApplicationClient",
  {
    api: Api.api,
    httpClient: FetchHttpClient.layer,
    baseUrl: globalThis.location.origin
  }
) {}
```

Define cached query families through the generated client:

```ts
export const user = (id: UserId) =>
  ApplicationClient.query("users", "get", {
    params: { userId: id },
    timeToLive: "2 seconds"
  })
```

Use the service's atom runtime for mutations and streams:

```ts
export const saveUser = ApplicationClient.runtime.fn(
  (input: SaveUserInput, get) =>
    ApplicationClient.use(client =>
      client.users.save({ payload: input })
    ).pipe(
      Effect.tap(() => Effect.sync(() => {
        get.refresh(currentUser)
      }))
    )
)
```

Rules:

- No scattered `Effect.runPromise`, `Effect.runFork`, or `Effect.runSync` in
  components.
- No component-owned fibers for SSE or subscriptions.
- Queries expose `AsyncResult` and retain previous values during refresh.
- Mutations expose waiting, success, and typed failure states.
- Refresh dependent atoms after accepted mutations.
- Mount long-lived stream atoms through React bindings.
- Keep URL and browser-global access in client-only modules.

A standalone `ManagedRuntime` is appropriate only for a real non-Atom frontend
boundary. It is not required for AtomHttpApi's native client integration.

### Atom module responsibilities

A frontend atom module may own:

- branded identity selection
- URL-decoded state
- query composition
- mutation workflows
- live event projection
- optimistic or ephemeral streaming text
- query invalidation
- browser history synchronization

```ts
export const selectedUserId = Atom.make(Option.none<UserId>())

export const selectedUser = Atom.make(get =>
  Option.match(get(selectedUserId), {
    onNone: () => Effect.succeed(Option.none<User>()),
    onSome: id => get.result(ApiClient.user(id)).pipe(Effect.map(Option.some))
  })
)
```

Decode URL values through the shared schema before placing them in state.

### React component responsibilities

Components may:

- use `useAtom`, `useAtomValue`, and `useAtomMount`
- render `AsyncResult` waiting/failure/success states
- derive presentation-only projections
- write intent to state or mutation atoms
- own imperative third-party UI handles when unavoidable

Components should not:

- construct HTTP clients
- call fetch directly
- launch effects
- supervise streams
- parse unvalidated server data
- duplicate domain state in local React state

Extract transport-independent views into pure components and test them with
React Testing Library.

### Server/client rendering boundary

When using React Server Components, keep read-oriented initial shells on the
server. Keep Effect Atom registry state, browser APIs, editors, graphs, SSE,
conversation, and mutations in explicit client components. The shared HttpApi
schemas and inferred client remain usable on both sides with the appropriate
platform client layer.

## AsyncResult UI handling

Every asynchronous atom exposes an `AsyncResult`.

- `Initial` means no resolved value yet.
- `Success` contains a value and may still be `waiting` during refresh.
- `Failure` contains a typed `Cause` and may preserve previous success.

Do not collapse these states into unrelated booleans that can contradict one
another. Render previous successful content while a refresh is waiting when
that is less disruptive.

Errors visible to users should have appropriate semantics such as `role="alert"`.
Busy operations should expose `aria-busy` or a polite status and use specific
labels such as `Saving…`, not merely disable a button without explanation.

## Testing

### Effect tests

Always import the Effect Vitest integration as a namespace:

```ts
import * as it from "@effect/vitest"
```

Use top-level `it.effect` for effectful tests:

```ts
it.effect("loads a validated user", () =>
  Effect.gen(function* () {
    const users = yield* Users
    const user = yield* users.load(userId)

    it.expect(user.id).toBe(userId)
  }).pipe(Effect.provide(TestLayer))
)
```

Rules:

- Return exactly one Effect from the test callback.
- Do not return a Promise from `it.effect`.
- Use `Effect.scoped` for temporary resources.
- Provide production layers or narrowly controlled test layers.
- Test expected failures through `Effect.exit` or typed recovery.
- Assert tags and structured fields, not error prose alone.
- Use schema decoding to construct branded fixture values.
- Prefer a few meaningful behavior tests over line-coverage chasing.

### Disposable integration fixtures

Never point tests at the application's own working repository or user data.
Build disposable projects with Effect `FileSystem`, scoped temp directories,
and the real production decoder.

Sort fixture output and keep fixture constructors named by domain purpose.

### Frontend component tests

Use React Testing Library with Vitest and jsdom:

```tsx
// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest"
import * as TestingLibrary from "@testing-library/react"
import * as it from "@effect/vitest"
import * as Effect from "effect/Effect"

it.afterEach(TestingLibrary.cleanup)

it.effect("selects a user", () =>
  Effect.sync(() => {
    const onSelect = it.vi.fn()
    TestingLibrary.render(<UserList users={users} onSelect={onSelect} />)

    TestingLibrary.fireEvent.click(
      TestingLibrary.screen.getByRole("button", { name: /Ada/ })
    )

    it.expect(onSelect).toHaveBeenCalledExactlyOnceWith(users[0]?.id)
  })
)
```

Test user-visible semantics:

- accessible roles and names
- selected state
- keyboard actions
- formatted domain content
- empty, busy, error, and success states
- responsive or modal behavior where important

Do not assert implementation details such as internal atom counters or CSS class
names unless the class itself is the behavior under test.

### Vitest configuration

Keep Vitest rooted at the repository even when Vite builds from `web/`:

```ts
import * as VitestConfig from "vitest/config"

export default VitestConfig.defineConfig({
  test: {
    include: ["test/**/*.test.ts", "web/**/*.test.tsx"]
  }
})
```

A Vite `root: "web"` without a separate Vitest config can accidentally cause
backend tests to disappear.

## Vite configuration

```ts
import * as ReactPlugin from "@vitejs/plugin-react"
import * as Vite from "vite"

export default Vite.defineConfig({
  root: "web",
  plugins: [ReactPlugin.default()],
  build: {
    outDir: "../dist-web",
    emptyOutDir: true
  }
})
```

Serve production assets from the Effect HTTP server when a same-origin local
application is desired. Load assets through `FileSystem`, distinguish files from
directories with `stat`, use explicit content types, and bind local development
servers to `127.0.0.1` unless remote access is an explicit feature.

## Concurrency, commands, and external processes

- Run independent effects with explicit concurrency through `Effect.all` or
  `Effect.forEach`.
- Use scopes so interrupted fibers terminate child processes and streams.
- Put timeouts around external processes and SDK operations.
- Capture stdout, stderr, exit code, command, and working directory.
- Resolve executables explicitly when login-shell PATH behavior matters.
- Treat non-zero exit semantics in the domain layer; the process adapter should
  report the process faithfully.
- Shell execution is acceptable only for trusted application-owned command
  strings. User-controlled arguments must use structured process arguments.

## Observability

- Give important operations stable `Effect.fn` span names.
- Preserve operation/stage fields in errors.
- Keep logs at boundaries; do not scatter unstructured logging through domain
  functions.
- Attach request, session, command, or task identities where they help correlate
  work.
- Do not persist duplicate conversational history merely for observability.

## Documentation

- Put client-facing descriptions on schemas so OpenAPI and generated tooling can
  carry them.
- Use comments for private implementation rationale and invariant protection.
- Document database schemas by explaining how records participate in the
  application, not by repeating column names.
- Keep examples valid under the strict compiler and current package versions.

## Common anti-patterns

Do not:

- call `Effect.runPromise` throughout business logic
- call `Effect.runFork` from React components
- create a separate runtime around AtomHttpApi
- expose raw SDK Promises from services
- use `node:fs` in domain services
- use unbranded strings for unrelated identities
- cast untrusted values into domain types
- model lifecycle variants with contradictory optional fields
- represent ordinary absence with `null`
- throw generic errors for expected failures
- parse error messages to decide recovery
- make service consumers provide the service's private dependencies
- create a new stateful layer on each call
- repeat API request/response schemas on client and server
- duplicate durable history in a coordination database
- write tests against a developer's real workspace
- disable strict compiler flags to silence design errors
- add broad abstractions before two concrete modules need them

## Definition of done

Before considering an Effect application change complete:

1. External values are decoded through schemas.
2. New identities remain branded end to end.
3. Expected failures are tagged and typed.
4. Service dependencies are captured in layers.
5. Scopes and interruption clean up resources.
6. Frontend effects live in atoms, not components.
7. The shared API still infers both handlers and clients.
8. Every new backend source module has a focused test module.
9. Component behavior is tested through accessible UI.
10. `tsc -b` passes without weakening strictness.
11. Effect/Vitest tests pass.
12. The production build passes.
13. Generated files and runtime state are excluded from Git.
14. Any intentional deviation from this guide is documented with its reason.
