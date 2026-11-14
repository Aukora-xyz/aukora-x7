/**
 * A small generic evaluator for a serialized affine/ReLU graph, schema `finite-affine-relu.v1` (test tree only). It knows
 * nothing about any CPU: no opcode, no register, no pc. A graph is `{ schema, inputs, nodes, outputs }`; node i is
 * `[bias, activation, [[source, weight], ...]]` and writes wire `inputs + i` = bias + sum(weight * wire[source]), passed
 * through ReLU when activation is 1. Every source must be an earlier wire, so one pass in order evaluates the graph.
 */

export interface CompiledGraph {
  readonly inputs: number
  readonly nodes: number
  readonly edges: number
  /** Biases plus edge weights: the scalars that ARE the machine. */
  readonly scalars: number
  /** Evaluate one input vector (length `inputs`); returns the output wires. */
  forward(input: Int32Array): Int32Array
}

const isInt = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value)

/**
 * Check and compile a graph into flat typed arrays.
 * @param graph - the parsed JSON graph.
 * @returns the compiled graph.
 * @throws on any shape problem, a non-integer scalar, a forward reference, or an output out of range.
 */
export function compileAffineRelu(graph: unknown): CompiledGraph {
  if (graph === null || typeof graph !== 'object') throw new Error('graph is not an object')
  const { schema, inputs, nodes, outputs } = graph as Record<string, unknown>
  if (schema !== 'finite-affine-relu.v1') throw new Error('schema')
  if (!isInt(inputs) || inputs < 1) throw new Error('inputs')
  if (!Array.isArray(nodes) || !Array.isArray(outputs)) throw new Error('nodes or outputs')
  const bias = new Int32Array(nodes.length), relu = new Uint8Array(nodes.length), start = new Int32Array(nodes.length + 1)
  const sources: number[] = [], weights: number[] = []
  nodes.forEach((node: unknown, index) => {
    if (!Array.isArray(node) || node.length !== 3) throw new Error(`node ${String(index)}`)
    const [b, activation, edges] = node as [unknown, unknown, unknown]
    if (!isInt(b) || (activation !== 0 && activation !== 1) || !Array.isArray(edges)) throw new Error(`node ${String(index)}`)
    bias[index] = b
    relu[index] = activation
    start[index] = sources.length
    for (const edge of edges as unknown[]) {
      if (!Array.isArray(edge) || edge.length !== 2) throw new Error(`edge of node ${String(index)}`)
      const [source, weight] = edge as [unknown, unknown]
      if (!isInt(source) || source < 0 || source >= inputs + index || !isInt(weight)) throw new Error(`edge of node ${String(index)}`)
      sources.push(source)
      weights.push(weight)
    }
  })
  start[nodes.length] = sources.length
  const wires = inputs + nodes.length
  const out = Int32Array.from(outputs as unknown[], (value) => {
    if (!isInt(value) || value < 0 || value >= wires) throw new Error('output')
    return value
  })
  const src = Int32Array.from(sources), wt = Int32Array.from(weights)
  const tape = new Int32Array(wires)
  const result = new Int32Array(out.length)
  return {
    inputs,
    nodes: nodes.length,
    edges: sources.length,
    scalars: nodes.length + sources.length,
    forward(input) {
      if (input.length !== inputs) throw new Error('input length')
      tape.set(input)
      for (let index = 0; index < bias.length; index += 1) {
        let value = bias[index]!
        for (let edge = start[index]!; edge < start[index + 1]!; edge += 1) value += tape[src[edge]!]! * wt[edge]!
        tape[inputs + index] = relu[index] === 1 && value < 0 ? 0 : value
      }
      for (let index = 0; index < out.length; index += 1) result[index] = tape[out[index]!]!
      return result
    },
  }
}
