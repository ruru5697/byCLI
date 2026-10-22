import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { load } from 'js-yaml';

describe('release workflow', () => {
  it('publishes recorder core only when its exact version is absent from npm', () => {
    const workflow = readFileSync('.github/workflows/release.yml', 'utf8');

    expect(workflow).toContain('id: recorder_core_status');
    expect(workflow).toContain('npm view "${PACKAGE_NAME}@${PACKAGE_VERSION}" version');
    expect(workflow).toContain("published=true");
    expect(workflow).toContain("published=false");
    expect(workflow).toContain("if: steps.recorder_core_status.outputs.published != 'true'");
    expect(workflow).toContain('id: package_status');
    expect(workflow).toContain("if: steps.package_status.outputs.published != 'true'");
    expect(workflow).toContain('WEBSITE_DEPLOY_TOKEN: ${{ secrets.WEBSITE_DEPLOY_TOKEN }}');
    expect(workflow).toContain("if: env.WEBSITE_DEPLOY_TOKEN != ''");
  });

  it('retries an existing tag without publishing the workflow branch as a release', () => {
    const workflow = load(readFileSync('.github/workflows/release.yml', 'utf8')) as any;
    expect(workflow.on.workflow_dispatch.inputs.tag.required).toBe(true);
    expect(workflow.on.workflow_dispatch.inputs.diagnostics_only.default).toBe(false);
    expect(workflow.jobs.release.if).toContain('!inputs.diagnostics_only');
    expect(workflow.jobs['registry-diagnostics'].if).toContain('inputs.diagnostics_only');
    const steps = workflow.jobs.release.steps;
    expect(steps.find((step: any) => step.uses === 'actions/checkout@v6').with.ref)
      .toBe('${{ inputs.tag || github.ref }}');
    expect(steps.find((step: any) => step.name === 'Create GitHub Release').with.tag_name)
      .toBe('${{ inputs.tag || github.ref_name }}');
    const publish = steps.find((step: any) => step.name === 'Publish to npm');
    expect(publish.run).toContain('exit "$publish_status"');
    expect(publish.run).toContain('--loglevel=verbose');
    const upload = steps.find((step: any) => step.name === 'Save sanitized npm publish diagnostics');
    expect(upload.if).toContain('always()');
    expect(upload.with.path).toBe('${{ runner.temp }}/npm-publish-diagnostics.txt');
    expect(steps.find((step: any) => step.name === 'Inspect npm authentication response')['continue-on-error']).toBe(true);
  });
});
