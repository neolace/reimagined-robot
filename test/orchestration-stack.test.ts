import { Match } from 'aws-cdk-lib/assertions';
import { devConfig, uatConfig } from '../infra/config';
import { buildStage, json, resourcesOf } from './helpers';

describe('OrchestrationStack', () => {
  const { orchestration } = buildStage(uatConfig).templates;
  const stateMachines = resourcesOf(orchestration, 'AWS::StepFunctions::StateMachine');
  const definitionOf = (name: string): string => {
    const found = stateMachines.find(([, sm]) => sm.Properties.StateMachineName === name);
    if (!found) throw new Error(`State machine ${name} not found`);
    return json(found[1].Properties.DefinitionString);
  };

  test('state machines keep the names from the architecture diagram', () => {
    expect(stateMachines.map(([, sm]) => sm.Properties.StateMachineName).sort()).toEqual([
      'gm-prime-equities-a2x-transfer',
      'gm-prime-equities-bda-daily',
      'gm-prime-equities-market-data',
      'gm-prime-equities-options-data',
      'gm-prime-equities-reference-data',
      'gm-prime-equities-step-function-a2x-sftp',
    ]);
    for (const [, sm] of stateMachines) {
      expect(sm.Properties).toMatchObject({
        TracingConfiguration: { Enabled: true },
        LoggingConfiguration: { Level: 'ERROR', IncludeExecutionData: false },
      });
    }
  });

  test('retrieve definition starts a transfer, polls, and treats a missing file as success', () => {
    const definition = definitionOf('gm-prime-equities-bda-daily');
    for (const fragment of [
      ':states:::aws-sdk:transfer:startFileTransfer',
      ':states:::aws-sdk:transfer:listFileTransferResults',
      'RetrieveFilePaths.$',
      '/jse/idp/bda/temp',
      'FileNotAvailable',
      'TransferFailed',
      'Transfer.ThrottlingException',
      'FULL',
    ]) {
      expect(definition).toContain(fragment);
    }
    expect(definition).toMatch(/TimeoutSeconds\\":900/);
  });

  test('A2X outer machine resolves the date, then runs the transfer synchronously', () => {
    const definition = definitionOf('gm-prime-equities-step-function-a2x-sftp');
    expect(definition).toContain('DetermineDate');
    expect(definition).toContain(':states:startExecution.sync');
    expect(definition).toContain('States.Format(');
    expect(definition).toContain('/outbound/equities/EQ_REF_{}.csv');
  });

  test('two schedule groups with the diagram names', () => {
    orchestration.resourceCountIs('AWS::Scheduler::ScheduleGroup', 2);
    orchestration.hasResourceProperties('AWS::Scheduler::ScheduleGroup', {
      Name: 'gm-prime-equities-scheduler-group-jse-sftp',
    });
    orchestration.hasResourceProperties('AWS::Scheduler::ScheduleGroup', {
      Name: 'gm-prime-equities-scheduler-group-a2x-sftp',
    });
  });

  test('bda schedule fires every 30 minutes 03:00-06:30 SAST on weekdays, with a DLQ', () => {
    orchestration.hasResourceProperties('AWS::Scheduler::Schedule', {
      Name: 'gm-prime-equities-jse-sftp-bda',
      ScheduleExpression: 'cron(0/30 3-6 ? * MON-FRI *)',
      ScheduleExpressionTimezone: 'Africa/Johannesburg',
      FlexibleTimeWindow: { Mode: 'OFF' },
      State: 'ENABLED',
      Target: Match.objectLike({
        Input: json({ remoteFilePaths: [uatConfig.jse.feeds.bda.remotePath] }),
        DeadLetterConfig: { Arn: Match.anyValue() },
        RetryPolicy: { MaximumEventAgeInSeconds: 3600, MaximumRetryAttempts: 3 },
      }),
    });
  });

  test('every feed has a schedule in its group, firing every 30 minutes 03:00-06:30 SAST', () => {
    const schedules = resourcesOf(orchestration, 'AWS::Scheduler::Schedule').map(([, s]) => s.Properties);
    expect(schedules.map((s) => [s.GroupName, s.Name]).sort()).toEqual([
      ['gm-prime-equities-scheduler-group-a2x-sftp', 'gm-prime-equities-schedule-a2x-sftp'],
      ['gm-prime-equities-scheduler-group-jse-sftp', 'gm-prime-equities-jse-sftp-bda'],
      ['gm-prime-equities-scheduler-group-jse-sftp', 'gm-prime-equities-jse-sftp-market-data'],
      ['gm-prime-equities-scheduler-group-jse-sftp', 'gm-prime-equities-jse-sftp-options-data'],
      ['gm-prime-equities-scheduler-group-jse-sftp', 'gm-prime-equities-jse-sftp-reference-data'],
    ]);
    for (const schedule of schedules) {
      expect(schedule.ScheduleExpression).toBe('cron(0/30 3-6 ? * MON-FRI *)');
    }
  });

  test('each schedule targets the state machine the diagram puts inside it', () => {
    const refTo = (name: string) => {
      const found = stateMachines.find(([, sm]) => sm.Properties.StateMachineName === name);
      if (!found) throw new Error(`State machine ${name} not found`);
      return { Ref: found[0] };
    };
    const expected: Record<string, string> = {
      'gm-prime-equities-schedule-a2x-sftp': 'gm-prime-equities-step-function-a2x-sftp',
      'gm-prime-equities-jse-sftp-bda': 'gm-prime-equities-bda-daily',
      'gm-prime-equities-jse-sftp-market-data': 'gm-prime-equities-market-data',
      'gm-prime-equities-jse-sftp-reference-data': 'gm-prime-equities-reference-data',
      'gm-prime-equities-jse-sftp-options-data': 'gm-prime-equities-options-data',
    };
    for (const [schedule, stateMachine] of Object.entries(expected)) {
      orchestration.hasResourceProperties('AWS::Scheduler::Schedule', {
        Name: schedule,
        Target: Match.objectLike({ Arn: refTo(stateMachine) }),
      });
    }
  });

  test('dev retrieval machines use the existing connectors named in the diagram', () => {
    const dev = resourcesOf(buildStage(devConfig).templates.orchestration, 'AWS::StepFunctions::StateMachine');
    const devDefinitionOf = (name: string): string =>
      json(dev.find(([, sm]) => sm.Properties.StateMachineName === name)?.[1].Properties.DefinitionString);
    const jseConnector = 'c-dsfgdsfgsdfdgsdf';
    const a2xConnector = 'c-sadfsdfsdfsddfsd';
    for (const name of [
      'gm-prime-equities-bda-daily',
      'gm-prime-equities-market-data',
      'gm-prime-equities-reference-data',
      'gm-prime-equities-options-data',
    ]) {
      expect(devDefinitionOf(name)).toContain(jseConnector);
      expect(devDefinitionOf(name)).not.toContain(a2xConnector);
    }
    expect(devDefinitionOf('gm-prime-equities-a2x-transfer')).toContain(a2xConnector);
    expect(devDefinitionOf('gm-prime-equities-a2x-transfer')).not.toContain(jseConnector);
  });

  test('schedules are disabled in dev by default', () => {
    const dev = buildStage(devConfig).templates.orchestration;
    for (const [, schedule] of resourcesOf(dev, 'AWS::Scheduler::Schedule')) {
      expect(schedule.Properties.State).toBe('DISABLED');
    }
  });

  test('date Lambda runs on arm64 with the latest Node.js runtime', () => {
    orchestration.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'gm-prime-equities-date',
      Runtime: 'nodejs24.x',
      Architectures: ['arm64'],
      TracingConfig: { Mode: 'Active' },
    });
  });
});
