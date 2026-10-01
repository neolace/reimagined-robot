import { Duration, Stack, StackProps, TimeZone } from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as events from 'aws-cdk-lib/aws-events';
import * as eventsTargets from 'aws-cdk-lib/aws-events-targets';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import * as schedulerTargets from 'aws-cdk-lib/aws-scheduler-targets';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import { Construct } from 'constructs';
import { A2X_FEED, EnvironmentConfig, finalKeyFor, JSE_FEEDS } from '../../config';
import { createDeadLetterQueue } from '../constructs/feed-schedule';
import { TypeScriptFunction } from '../constructs/typescript-function';
import { acknowledge } from '../nag';
import type { DeadlineFeed } from '../../../src/lambdas/file-deadline-check';

export interface MonitoringStackProps extends StackProps {
  readonly config: EnvironmentConfig;
  readonly bucket: s3.IBucket;
  readonly dataKey: kms.IKey;
  readonly stateMachines: Record<string, sfn.IStateMachine>;
  readonly functions: lambda.IFunction[];
  readonly deadLetterQueues: sqs.IQueue[];
}

export const DEADLINE_CHECK_FUNCTION_NAME = 'gm-prime-file-deadline-check';
export const METRICS_NAMESPACE = 'PrimeSftpIngestion';

/** Alert topic, alarms, deadline check and dashboard. See docs/operations/observability-and-runbook.md. */
export class MonitoringStack extends Stack {
  public readonly alertTopic: sns.Topic;

  constructor(scope: Construct, id: string, props: MonitoringStackProps) {
    super(scope, id, props);
    const { config } = props;

    this.alertTopic = new sns.Topic(this, 'AlertTopic', {
      topicName: `prime-${config.envName}-ingestion-alerts`,
      masterKey: props.dataKey,
      enforceSSL: true,
    });
    for (const email of config.alarmEmails) {
      this.alertTopic.addSubscription(new subscriptions.EmailSubscription(email));
    }
    const alarmAction = new cwActions.SnsAction(this.alertTopic);
    const alarm = (id: string, metric: cloudwatch.IMetric, description: string): cloudwatch.Alarm => {
      const a = new cloudwatch.Alarm(this, id, {
        alarmName: `prime-${config.envName}-${id}`,
        alarmDescription: description,
        metric,
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });
      a.addAlarmAction(alarmAction);
      return a;
    };
    const period = Duration.minutes(5);
    const alarms: cloudwatch.Alarm[] = [];
    const runbook = 'docs/operations/observability-and-runbook.md';

    for (const [name, sm] of Object.entries(props.stateMachines)) {
      alarms.push(
        alarm(
          `${name}-failed`,
          sm.metricFailed({ period }),
          `${name} execution failed. Runbook: ${runbook}#transfer-failed`,
        ),
        alarm(
          `${name}-timed-out`,
          sm.metricTimedOut({ period }),
          `${name} timed out. Runbook: ${runbook}#transfer-failed`,
        ),
      );
    }
    for (const fn of props.functions) {
      alarms.push(alarm(`${fn.node.id}-errors`, fn.metricErrors({ period }), `Lambda errors. Runbook: ${runbook}`));
    }

    // ---------- Deadline check (TypeScript Lambda on a schedule) ----------
    const deadlineFeeds: DeadlineFeed[] = [
      ...JSE_FEEDS.filter((f) => config.jse.feeds[f.id].enabled).map((f) => ({
        feed: f.id,
        kind: 'stamped' as const,
        key: finalKeyFor(f.prefix, config.jse.feeds[f.id].remotePath),
      })),
      ...(config.a2x.enabled
        ? [{ feed: 'a2x', kind: 'dated' as const, key: finalKeyFor(A2X_FEED.prefix, config.a2x.remotePathTemplate) }]
        : []),
    ];

    const deadlineCheck = new TypeScriptFunction(this, 'FileDeadlineCheck', {
      functionName: DEADLINE_CHECK_FUNCTION_NAME,
      sourceDir: 'file-deadline-check',
      logRetention: config.logRetention,
      timeout: Duration.seconds(30),
      environment: {
        BUCKET_NAME: props.bucket.bucketName,
        ALERT_TOPIC_ARN: this.alertTopic.topicArn,
        FEEDS: JSON.stringify(deadlineFeeds),
        POWERTOOLS_METRICS_NAMESPACE: METRICS_NAMESPACE,
      },
    });
    props.bucket.grantRead(deadlineCheck);
    this.alertTopic.grantPublish(deadlineCheck);
    alarms.push(alarm('FileDeadlineCheck-errors', deadlineCheck.metricErrors({ period }), 'Deadline check failed.'));

    const deadlineDlq = createDeadLetterQueue(this, 'DeadlineCheckDlq', 'gm-prime-file-deadline-check-dlq');
    new scheduler.Schedule(this, 'DeadlineCheckSchedule', {
      scheduleName: 'gm-prime-file-deadline-check',
      schedule: scheduler.ScheduleExpression.cron({
        minute: String(config.fileDeadline.minute),
        hour: String(config.fileDeadline.hour),
        weekDay: 'MON-FRI',
        timeZone: TimeZone.AFRICA_JOHANNESBURG,
      }),
      enabled: deadlineFeeds.length > 0,
      target: new schedulerTargets.LambdaInvoke(deadlineCheck, {
        deadLetterQueue: deadlineDlq,
        retryAttempts: 2,
        maxEventAge: Duration.minutes(30),
      }),
    });

    acknowledge(deadlineDlq, [{ id: 'AwsSolutions-SQS3', reason: 'This queue is itself a dead-letter queue.' }]);
    for (const role of this.node.children.filter((c) => c.node.id.startsWith('SchedulerRoleForTarget'))) {
      acknowledge(role, [
        { id: 'AwsSolutions-IAM5', reason: 'Scheduler may invoke any version/alias of the deadline-check function.' },
      ]);
    }

    for (const dlq of [...props.deadLetterQueues, deadlineDlq]) {
      alarms.push(
        alarm(
          `${dlq.node.id}-not-empty`,
          dlq.metricApproximateNumberOfMessagesVisible({ period }),
          `Messages in ${dlq.node.id}. Runbook: ${runbook}#messages-in-a-dlq`,
        ),
      );
    }

    // ---------- Connector retrieve failures (Transfer Family events) ----------
    new events.Rule(this, 'ConnectorRetrieveFailed', {
      description: 'Notify on any SFTP connector retrieve failure',
      eventPattern: { source: ['aws.transfer'], detailType: ['SFTP Connector File Retrieve Failed'] },
      targets: [new eventsTargets.SnsTopic(this.alertTopic)],
    });

    // ---------- Dashboard ----------
    const dashboard = new cloudwatch.Dashboard(this, 'Dashboard', {
      dashboardName: `prime-${config.envName}-sftp-ingestion`,
      defaultInterval: Duration.days(1),
    });
    const stateMachineEntries = Object.entries(props.stateMachines);
    dashboard.addWidgets(
      new cloudwatch.TextWidget({
        markdown: `# Prime SFTP ingestion (${config.envName})\nJSE feeds poll 03:00–06:30 SAST on weekdays. Missing files are checked at ${String(config.fileDeadline.hour).padStart(2, '0')}:${String(config.fileDeadline.minute).padStart(2, '0')}. Runbook: \`${runbook}\``,
        width: 24,
        height: 2,
      }),
      new cloudwatch.AlarmStatusWidget({ title: 'Alarms', alarms, width: 24, height: 6 }),
    );
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Executions succeeded',
        left: stateMachineEntries.map(([name, sm]) => sm.metricSucceeded({ label: name, period: Duration.hours(1) })),
        width: 12,
      }),
      new cloudwatch.GraphWidget({
        title: 'Executions failed / timed out',
        left: stateMachineEntries.flatMap(([name, sm]) => [
          sm.metricFailed({ label: `${name} failed`, period: Duration.hours(1) }),
          sm.metricTimedOut({ label: `${name} timed out`, period: Duration.hours(1) }),
        ]),
        width: 12,
      }),
    );
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Lambda invocations / errors',
        left: [...props.functions, deadlineCheck].map((fn) => fn.metricInvocations({ label: fn.node.id })),
        right: [...props.functions, deadlineCheck].map((fn) => fn.metricErrors({ label: `${fn.node.id} errors` })),
        width: 12,
      }),
      new cloudwatch.GraphWidget({
        title: 'Lambda duration p95',
        left: [...props.functions, deadlineCheck].map((fn) =>
          fn.metricDuration({ label: fn.node.id, statistic: 'p95' }),
        ),
        width: 12,
      }),
    );
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Dead-letter queue depth',
        left: [...props.deadLetterQueues, deadlineDlq].map((q) =>
          q.metricApproximateNumberOfMessagesVisible({ label: q.node.id }),
        ),
        width: 12,
      }),
      new cloudwatch.GraphWidget({
        title: 'Missing files at deadline',
        left: deadlineFeeds.map(
          (f) =>
            new cloudwatch.Metric({
              namespace: METRICS_NAMESPACE,
              metricName: 'FileMissing',
              dimensionsMap: { service: DEADLINE_CHECK_FUNCTION_NAME, Feed: f.feed },
              statistic: 'Sum',
              period: Duration.days(1),
              label: f.feed,
            }),
        ),
        width: 12,
      }),
    );
  }
}
