#!/usr/bin/env node
/* global console, process */
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const workspace = resolve(process.argv[2] ?? process.cwd());
const taskPath = join(workspace, 'TASK.json');

const errors = [];

const pushError = (message) => {
  errors.push(message);
};

const validateString = (value, path) => {
  if (typeof value !== 'string' || value.trim().length === 0) {
    pushError(`${path} must be a non-empty string`);
  }
};

const validateFeature = (feature, path) => {
  if (!feature || typeof feature !== 'object' || Array.isArray(feature)) {
    pushError(`${path} must be an object`);
    return;
  }
  validateString(feature.id, `${path}.id`);
  validateString(feature.description, `${path}.description`);
  if (!['pending', 'in_progress', 'done', 'failed', 'skipped'].includes(feature.status)) {
    pushError(`${path}.status is invalid (${String(feature.status)})`);
  }
  if (typeof feature.attempts !== 'number' || Number.isNaN(feature.attempts)) {
    pushError(`${path}.attempts must be a number`);
  }
};

const validateCheck = (check, path) => {
  if (!check || typeof check !== 'object' || Array.isArray(check)) {
    pushError(`${path} must be an object`);
    return;
  }
  validateString(check.id, `${path}.id`);
  validateString(check.description, `${path}.description`);
};

const validateMilestone = (milestone, path) => {
  if (!milestone || typeof milestone !== 'object' || Array.isArray(milestone)) {
    pushError(`${path} must be an object`);
    return;
  }
  validateString(milestone.id, `${path}.id`);
  validateString(milestone.title, `${path}.title`);
  validateString(milestone.description, `${path}.description`);

  if (!Array.isArray(milestone.features) || milestone.features.length === 0) {
    pushError(`${path}.features must be a non-empty array`);
  } else {
    milestone.features.forEach((feature, index) => validateFeature(feature, `${path}.features[${index}]`));
  }

  const contract = milestone.validationContract;
  if (!contract || typeof contract !== 'object' || Array.isArray(contract)) {
    pushError(`${path}.validationContract must be an object`);
    return;
  }

  if (Object.prototype.hasOwnProperty.call(contract, 'e2eChecks')) {
    pushError(`${path}.validationContract.e2eChecks is no longer supported; use browserChecks instead`);
  }

  const groups = ['staticChecks', 'testSuites', 'browserChecks', 'manualSteps'];
  for (const group of groups) {
    const checks = contract[group] ?? [];
    if (!Array.isArray(checks)) {
      pushError(`${path}.validationContract.${group} must be an array`);
      continue;
    }
    checks.forEach((check, index) => validateCheck(check, `${path}.validationContract.${group}[${index}]`));
  }
};

if (!existsSync(taskPath)) {
  console.log('[preflight-task-format] TASK.json not found; planning will generate a new mission plan.');
  process.exit(0);
}

let task;
try {
  task = JSON.parse(readFileSync(taskPath, 'utf-8'));
} catch (error) {
  console.error(`[preflight-task-format] ERROR: TASK.json is not valid JSON: ${String(error)}`);
  process.exit(1);
}

if (!task || typeof task !== 'object' || Array.isArray(task)) {
  pushError('TASK.json must be a MissionPlan object');
} else {
  if (task.version !== 3) {
    pushError(`version must be 3 (received=${String(task.version)})`);
  }

  if (!task.mission || typeof task.mission !== 'object' || Array.isArray(task.mission)) {
    pushError('mission must be an object');
  } else {
    validateString(task.mission.goal, 'mission.goal');
    if (!Array.isArray(task.mission.constraints)) {
      pushError('mission.constraints must be an array');
    }
    if (!Array.isArray(task.mission.successCriteria)) {
      pushError('mission.successCriteria must be an array');
    }
  }

  if (!Array.isArray(task.milestones) || task.milestones.length === 0) {
    pushError('milestones must be a non-empty array');
  } else {
    task.milestones.forEach((milestone, index) => validateMilestone(milestone, `milestones[${index}]`));
  }
}

if (errors.length > 0) {
  console.error('[preflight-task-format] INVALID TASK.json');
  for (const error of errors) {
    console.error(`  - ${error}`);
  }
  process.exit(1);
}

console.log('[preflight-task-format] OK');
console.log(`workspace: ${workspace}`);
console.log(`task: ${taskPath}`);
