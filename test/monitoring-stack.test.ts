import { Match } from 'aws-cdk-lib/assertions';
import { prodConfig } from '../infra/config';
import { buildStage, resourcesOf } from './helpers';

describe('MonitoringStack', () => {
  const { monitoring } = buildStage(prodConfig).templates;
  const alarmNames = resourcesOf(monitoring, 'AWS::CloudWatch::Alarm').map(([, a]) => a.Properties.AlarmName as string);

  test('alert topic is KMS-encrypted and subscribed', () => {
    monitoring.hasResourceProperties('AWS::SNS::Topic', {
      TopicName: 'prime-prod-ingestion-alerts',
      KmsMasterKeyId: Match.anyValue(),
    });
    monitoring.hasResourceProperties('AWS::SNS::Subscription', {
      Protocol: 'email',
      Endpoint: prodConfig.alarmEmails[0],
    });
  });

  test('every state machine has failed and timed-out alarms', () => {
    for (const name of [
      'gm-prime-equities-bda',
      'gm-prime-equities-market-data',
      'gm-prime-equities-reference-data',
      'gm-prime-equities-options-data',
      'gm-prime-equities-a2x-transfer',
      'gm-prime-equities-a2x',
    ]) {
      expect(alarmNames).toContain(`prime-prod-${name}-failed`);
      expect(alarmNames).toContain(`prime-prod-${name}-timed-out`);
    }
  });

  test('Lambda error and DLQ alarms exist, and all notify the alert topic', () => {
    expect(alarmNames).toEqual(
      expect.arrayContaining([
        'prime-prod-EquitiesDate-errors',
        'prime-prod-ShadowRename-errors',
        'prime-prod-FileDeadlineCheck-errors',
        'prime-prod-JseScheduleDlq-not-empty',
        'prime-prod-A2xScheduleDlq-not-empty',
        'prime-prod-ShadowRenameDlq-not-empty',
        'prime-prod-DeadlineCheckDlq-not-empty',
      ]),
    );
    for (const [, alarm] of resourcesOf(monitoring, 'AWS::CloudWatch::Alarm')) {
      expect(alarm.Properties).toMatchObject({ TreatMissingData: 'notBreaching', AlarmActions: [expect.anything()] });
    }
  });

  test('deadline check runs at 07:00 SAST on weekdays', () => {
    monitoring.hasResourceProperties('AWS::Scheduler::Schedule', {
      Name: 'gm-prime-file-deadline-check',
      ScheduleExpression: 'cron(0 7 ? * MON-FRI *)',
      ScheduleExpressionTimezone: 'Africa/Johannesburg',
      State: 'ENABLED',
    });
    monitoring.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'gm-prime-file-deadline-check',
      Environment: {
        Variables: Match.objectLike({
          BUCKET_NAME: Match.anyValue(),
          FEEDS: Match.stringLikeRegexp('jse/idp/bda/BDA_FILE.csv'),
        }),
      },
    });
  });

  test('connector retrieve failures are routed to the alert topic', () => {
    monitoring.hasResourceProperties('AWS::Events::Rule', {
      EventPattern: { source: ['aws.transfer'], 'detail-type': ['SFTP Connector File Retrieve Failed'] },
    });
  });

  test('dashboard exists', () => {
    monitoring.hasResourceProperties('AWS::CloudWatch::Dashboard', { DashboardName: 'prime-prod-sftp-ingestion' });
  });
});
