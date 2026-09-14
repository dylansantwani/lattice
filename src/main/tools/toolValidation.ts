/** Small, cached JSON Schema validator for tool argument objects.
 *
 * This intentionally covers the JSON Schema vocabulary used by built-in and MCP tools. It is
 * synchronous and side-effect free so callers can validate before approval or execution.
 */
export interface ToolValidationIssue {
  path: string
  message: string
}

export interface ToolValidationResult {
  valid: boolean
  issues: ToolValidationIssue[]
}

export type CompiledToolValidator = (value: unknown) => ToolValidationResult

const cache = new WeakMap<object, CompiledToolValidator>()

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function typeMatches(type: string, value: unknown): boolean {
  switch (type) {
    case 'object': return isRecord(value)
    case 'array': return Array.isArray(value)
    case 'string': return typeof value === 'string'
    case 'number': return typeof value === 'number' && Number.isFinite(value)
    case 'integer': return typeof value === 'number' && Number.isInteger(value)
    case 'boolean': return typeof value === 'boolean'
    case 'null': return value === null
    default: return true
  }
}

function validateNode(schema: Record<string, unknown>, value: unknown, path: string, issues: ToolValidationIssue[]): void {
  if (schema.const !== undefined && !Object.is(value, schema.const)) {
    issues.push({ path, message: `must equal ${JSON.stringify(schema.const)}` })
    return
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((x) => Object.is(x, value))) {
    issues.push({ path, message: `must be one of ${schema.enum.map((x) => JSON.stringify(x)).join(', ')}` })
    return
  }
  const types = Array.isArray(schema.type) ? schema.type.filter((t): t is string => typeof t === 'string') :
    typeof schema.type === 'string' ? [schema.type] : []
  if (types.length && !types.some((type) => typeMatches(type, value))) {
    issues.push({ path, message: `must be ${types.join(' or ')}` })
    return
  }
  for (const key of ['allOf', 'anyOf', 'oneOf'] as const) {
    const branches = schema[key]
    if (!Array.isArray(branches)) continue
    const matches = branches.filter((branch) => {
      if (!isRecord(branch)) return true
      const nested: ToolValidationIssue[] = []
      validateNode(branch, value, path, nested)
      return nested.length === 0
    }).length
    const ok = key === 'allOf' ? matches === branches.length : key === 'anyOf' ? matches > 0 : matches === 1
    if (!ok) issues.push({ path, message: `must satisfy ${key}` })
  }
  if (isRecord(value)) {
    const properties = isRecord(schema.properties) ? schema.properties : {}
    const required = Array.isArray(schema.required) ? schema.required.filter((x): x is string => typeof x === 'string') : []
    for (const name of required) {
      if (!(name in value)) issues.push({ path: `${path}.${name}`, message: 'is required' })
    }
    for (const [name, child] of Object.entries(properties)) {
      if (name in value && isRecord(child)) validateNode(child, value[name], `${path}.${name}`, issues)
    }
    if (schema.additionalProperties === false) {
      for (const name of Object.keys(value)) {
        if (!(name in properties)) issues.push({ path: `${path}.${name}`, message: 'is not allowed' })
      }
    }
  }
  if (Array.isArray(value) && isRecord(schema.items)) {
    value.forEach((item, index) => validateNode(schema.items as Record<string, unknown>, item, `${path}[${index}]`, issues))
  }
  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) issues.push({ path, message: `must have at least ${schema.minLength} characters` })
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) issues.push({ path, message: `must have at most ${schema.maxLength} characters` })
  }
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) issues.push({ path, message: `must be >= ${schema.minimum}` })
    if (typeof schema.maximum === 'number' && value > schema.maximum) issues.push({ path, message: `must be <= ${schema.maximum}` })
  }
}

export function compileToolValidator(schema: Record<string, unknown>): CompiledToolValidator {
  const cached = cache.get(schema)
  if (cached) return cached
  const validator: CompiledToolValidator = (value) => {
    const issues: ToolValidationIssue[] = []
    validateNode(schema, value, '$', issues)
    return { valid: issues.length === 0, issues }
  }
  cache.set(schema, validator)
  return validator
}

export function validateToolArguments(schema: Record<string, unknown>, value: unknown): ToolValidationResult {
  return compileToolValidator(schema)(value)
}

export function assertValidToolArguments(schema: Record<string, unknown>, value: unknown): void {
  const result = validateToolArguments(schema, value)
  if (!result.valid) throw new Error(`Invalid tool arguments: ${result.issues.map((i) => `${i.path} ${i.message}`).join('; ')}`)
}
