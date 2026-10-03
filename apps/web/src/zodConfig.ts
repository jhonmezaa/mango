import { z } from 'zod';

// zod 4 probes `new Function('')` to enable its JIT. The CSP forbids eval and Trusted Types reject
// it, so the JIT is disabled explicitly (JS-XSS-003, REACT-TT-001).
z.config({ jitless: true });
