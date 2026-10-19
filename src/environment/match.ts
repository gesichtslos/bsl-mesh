export type Applicability = 'applicable' | 'inapplicable' | 'partially_applicable' | 'unknown';

export type ApplicabilitySpec = {
  task_families: string[] | null;
  form_types: string[] | null;
  client_types: string[] | null;
  ides: string[] | null;
  os_families: string[] | null;
  verified_client_versions: string[];
};

export type MatchQuery = {
  task_family?: string;
  form_type?: string;
  client_type?: string;
  ide?: string;
  os_family?: string;
  client_version?: string | null;
};

export type MatchResult = {
  applicability: Applicability;
  confirmed: boolean;
  reasons: string[];
  unknowns: string[];
};

export function matchProfile(spec: ApplicabilitySpec, query: MatchQuery): MatchResult {
  const reasons: string[] = [];
  const unknowns: string[] = [];
  let blocked = false;
  let matched = false;

  const check = (label: string, allowed: string[] | null, value: string | undefined) => {
    if (allowed === null) {
      return;
    }
    if (value === undefined || value === '' || value === 'unknown') {
      unknowns.push(label);
      return;
    }
    if (!allowed.includes(value)) {
      blocked = true;
      reasons.push(`${label} ${value} is outside the profile.`);
      return;
    }
    matched = true;
    reasons.push(`${label} ${value} is listed by the profile.`);
  };

  check('task_family', spec.task_families, query.task_family);
  check('form_type', spec.form_types, query.form_type);
  check('client_type', spec.client_types, query.client_type);
  check('ide', spec.ides, query.ide);
  check('os_family', spec.os_families, query.os_family);

  const version = query.client_version;
  if (spec.verified_client_versions.length === 0) {
    unknowns.push('client_version');
    reasons.push('No client version is recorded as verified.');
  } else if (version === undefined || version === null || version === '' || version === 'unknown') {
    unknowns.push('client_version');
    reasons.push('The client version is unknown.');
  } else if (!spec.verified_client_versions.includes(version)) {
    unknowns.push('client_version');
    reasons.push('The stated client version was not verified.');
  } else {
    matched = true;
    reasons.push('client_version is in the verified list.');
  }

  let applicability: Applicability;
  if (blocked) {
    applicability = 'inapplicable';
  } else if (unknowns.length > 0) {
    applicability = matched ? 'partially_applicable' : 'unknown';
  } else {
    applicability = 'applicable';
  }
  return {
    applicability,
    confirmed: applicability === 'applicable',
    reasons,
    unknowns,
  };
}
