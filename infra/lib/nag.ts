import {
  IPolicyValidationContext,
  IPolicyValidationPlugin,
  PolicyValidationPluginReport,
  PolicyViolation,
  Validations,
} from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import type { IConstruct } from 'constructs';

export interface Acknowledgement {
  readonly id: string;
  readonly reason: string;
}

/** Acknowledge cdk-nag rules on a construct and its children. Every entry needs a specific reason. */
export const acknowledge = (scope: IConstruct, rules: Acknowledgement[]): void => {
  for (const rule of rules) Validations.of(scope).acknowledge(rule);
};

const isAcknowledged = (construct: IConstruct | undefined, ruleId: string): boolean => {
  for (let current = construct; current; current = current.node.scope) {
    for (const entry of current.node.metadata) {
      if (entry.type !== Validations.ACKNOWLEDGED_RULES_METADATA_KEY || !entry.data) continue;
      const ids = Object.keys(entry.data as Record<string, string>).map((k) => k.replace(/^annotation::/i, ''));
      if (ids.includes(ruleId)) return true;
    }
  }
  return false;
};

/**
 * AwsSolutions checks where acknowledging a base rule (e.g. `AwsSolutions-IAM5`) also covers its granular
 * findings (e.g. `AwsSolutions-IAM5[Resource::...]`), matching cdk-nag v2 semantics. cdk-nag v3 only matches
 * exact finding ids, which embed environment-specific tokens.
 */
export class AwsSolutionsPlugin implements IPolicyValidationPlugin {
  public readonly name = 'AwsSolutions';
  private readonly checks: AwsSolutionsChecks;

  constructor(scope: IConstruct) {
    this.checks = new AwsSolutionsChecks(scope, { verbose: true });
  }

  validate(context: IPolicyValidationContext): PolicyValidationPluginReport {
    const root = (context as IPolicyValidationContext & { appConstruct?: IConstruct }).appConstruct;
    if (!root) return this.checks.validate(context);
    return this.validateScope(root);
  }

  /** Run the checks over a construct tree directly (used by tests). */
  validateScope(scope: IConstruct): PolicyValidationPluginReport {
    const report = this.checks.validateScope(scope);
    const byPath = new Map(scope.node.findAll().map((c) => [c.node.path, c]));
    const violations: PolicyViolation[] = [];
    for (const violation of report.violations) {
      const baseId = violation.ruleName.split('[')[0];
      const remaining = violation.violatingResources.filter(
        (r) => !isAcknowledged(byPath.get(r.constructPath ?? ''), baseId),
      );
      if (remaining.length > 0) violations.push({ ...violation, violatingResources: remaining });
    }
    return { ...report, success: violations.length === 0, violations };
  }
}
