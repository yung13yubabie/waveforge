// Original synthetic multilingual text with hand-assigned test boundaries.
// No singing model, recording, user lyrics, or external service is involved.
import { createSession } from '../../../src/js/lyrics/session.js'
export function multilingualFixture() {
  const session = createSession('第一句\nHello, world\nこんにちは\nمرحبا بالعالم\n', {
    name: 'synthetic-timing.wav', hash: '1'.repeat(64), duration: 8,
  })
  for (const [i, range] of [[0,[.1,1.5]], [1,[2,3]], [2,[3.5,4.5]], [3,[5,6]]]) {
    Object.assign(session.lines[i], { start: range[0], end: range[1], confirmed: true })
  }
  return session
}
