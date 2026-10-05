// Validates proposal traceability only. It does NOT test 136 product features.
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
const registry = JSON.parse(readFileSync(new URL('../docs/planning/waveforge-capabilities.proposed.json', import.meta.url), 'utf8'))
assert.equal(registry.kind, 'requirements_registry_not_runtime_implementation')
assert.equal(registry.all_command_and_test_ids_are_proposals, true)
const features = registry.features
const ids = new Set(features.map(feature => feature.id))
assert.equal(ids.size, features.length, 'Capability IDs must be unique')
assert.equal(registry.counts.features, features.length)
assert.equal(registry.counts.detail_option_groups, features.reduce((sum, feature) => sum + feature.detail_options.length, 0))
const lookup = new Map(features.map(feature => [feature.id, feature]))
const visited = new Set(), active = new Set()
function visit(id) {
  assert(!active.has(id), `Cyclic proposal dependency: ${id}`)
  if (visited.has(id)) return
  active.add(id)
  for (const dependency of lookup.get(id).dependencies) {
    assert(ids.has(dependency), `Missing dependency ${dependency}`)
    visit(dependency)
  }
  active.delete(id); visited.add(id)
}
for (const feature of features) {
  visit(feature.id)
  for (const source of feature.sources) assert(registry.sources[source], `Unknown source ${source}`)
  assert.equal(feature.ui.binding_status, 'unbound_proposal')
  assert.equal(feature.test_plan.status, 'not_run_for_this_spec')
  assert.equal(feature.shipping_gate, 'blocked_until_real_bindings_and_acceptance_evidence')
  for (const [key, value] of Object.entries(feature.implementation_bindings)) {
    assert(key === 'tests' ? Array.isArray(value) && value.length === 0 : value === null,
      `Proposal unexpectedly claims a runtime binding: ${feature.id}.${key}`)
  }
  for (const contract of ['engine_and_data_contract', 'persistence_and_undo_contract', 'render_export_contract', 'acceptance']) {
    assert(feature[contract]?.trim(), `Missing ${contract}: ${feature.id}`)
  }
}
console.log(`Proposal structure PASS: ${features.length} capabilities, ${registry.counts.detail_option_groups} detail groups; runtime bindings/test execution remain unimplemented/unverified`)
