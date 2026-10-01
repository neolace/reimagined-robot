import { Duration, TimeZone } from 'aws-cdk-lib';
import type { CronOptions } from 'aws-cdk-lib/aws-events';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import * as targets from 'aws-cdk-lib/aws-scheduler-targets';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import { Construct } from 'constructs';

export interface FeedScheduleProps {
  readonly scheduleName: string;
  readonly scheduleGroup: scheduler.IScheduleGroup;
  readonly stateMachine: sfn.IStateMachine;
  /** Interpreted in Africa/Johannesburg. */
  readonly cron: CronOptions;
  readonly input: Record<string, unknown>;
  readonly enabled: boolean;
  readonly deadLetterQueue: sqs.IQueue;
}

/** One EventBridge Scheduler schedule that starts a state machine. See docs/architecture/component-specs.md §6. */
export class FeedSchedule extends Construct {
  public readonly schedule: scheduler.Schedule;

  constructor(scope: Construct, id: string, props: FeedScheduleProps) {
    super(scope, id);

    this.schedule = new scheduler.Schedule(this, 'Schedule', {
      scheduleName: props.scheduleName,
      scheduleGroup: props.scheduleGroup,
      schedule: scheduler.ScheduleExpression.cron({ ...props.cron, timeZone: TimeZone.AFRICA_JOHANNESBURG }),
      timeWindow: scheduler.TimeWindow.off(),
      enabled: props.enabled,
      target: new targets.StepFunctionsStartExecution(props.stateMachine, {
        input: scheduler.ScheduleTargetInput.fromObject(props.input),
        deadLetterQueue: props.deadLetterQueue,
        retryAttempts: 3,
        maxEventAge: Duration.hours(1),
      }),
    });
  }
}

/** SSE-SQS dead-letter queue with TLS enforced. */
export const createDeadLetterQueue = (scope: Construct, id: string, queueName: string): sqs.Queue =>
  new sqs.Queue(scope, id, {
    queueName,
    encryption: sqs.QueueEncryption.SQS_MANAGED,
    enforceSSL: true,
    retentionPeriod: Duration.days(14),
  });
