import { describe, expect, it } from 'vitest';
import { getOmcSystemPrompt } from '../index.js';
import { getAgentDefinitions } from '../agents/definitions.js';
import { resolveSystemPrompt } from '../agents/prompt-helpers.js';

describe('skininthegamebros guidance', () => {
  it('appends skininthegamebros guidance to the orchestrator prompt', () => {
    const prompt = getOmcSystemPrompt();
    expect(prompt).toContain('Skininthegamebros Execution Guidance');
    expect(prompt).toContain('Report outcomes faithfully');
  });

  it('appends skininthegamebros guidance to agent prompts', () => {
    const agents = getAgentDefinitions();
    expect(agents.architect.prompt).toContain('## Skininthegamebros Guidance');
    expect(agents.architect.prompt).toContain('Default to writing no comments');
  });

  it('appends skininthegamebros guidance when resolving agent-role prompts', () => {
    const prompt = resolveSystemPrompt(undefined, 'architect');
    expect(prompt).toContain('## Skininthegamebros Guidance');
    expect(prompt).toContain('verify the result with tests');
  });
});
