'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  checkVersionPolicy, compareManifestVersions, compareLockVersions,
  determineBaseRef,
} = require('../scripts/checkVersionPolicy');

const MANIFEST = {
  name: 'winterbot', version: '2.8.0',
  scripts: { test: 'node --test' },
  dependencies: { 'discord.js': '^14.27.0' },
};
function lock(version = MANIFEST.version) {
  return { name: 'winterbot', version, lockfileVersion: 3,
    packages: { '': { name: 'winterbot', version, dependencies: {...MANIFEST.dependencies} } } };
}
function execute(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding:'utf8', windowsHide:true });
  if(result.status !== 0) throw new Error('git '+args.join(' ')+'\n'+result.stderr);
  return result.stdout.trim();
}
function createRepo() {
  const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'winterbot-version-policy-'));
  execute(cwd,'init','-b','main');
  execute(cwd,'config','user.name','Test');
  execute(cwd,'config','user.email','winterbot-tests@example.test');
  const put=(file,obj)=>fs.writeFileSync(path.join(cwd,file),JSON.stringify(obj,null,2)+'\n');
  put('package.json',MANIFEST);
  put('package-lock.json',lock());
  execute(cwd,'add','.');
  execute(cwd,'commit','-m','Current automatic release baseline');
  const base=execute(cwd,'rev-parse','HEAD');
  execute(cwd,'update-ref','refs/remotes/origin/main',base);
  return {cwd,base,put,commit:message=>{
    execute(cwd,'add','.');
    execute(cwd,'commit','-m',message);
  },clean:()=>fs.rmSync(cwd,{recursive:true,force:true})};
}

test('automated version policy permits ordinary changes without touching package versions',()=>{
  assert.doesNotThrow(()=>compareManifestVersions(MANIFEST,{
    ...MANIFEST, dependencies:{...MANIFEST.dependencies,'luxon':'^3'},
  }));
  assert.doesNotThrow(()=>compareLockVersions(lock(),{
    ...lock(),packages:{'':{...lock().packages[''],dependencies:{...MANIFEST.dependencies,'luxon':'^3'}}},
  },MANIFEST.version));
});

test('manual package.json version changes are rejected, even patch and minor increments',()=>{
  for(const forbidden of ['2.8.1','2.9.0','3.0.0','2.7.0']) {
    assert.throws(()=>compareManifestVersions(MANIFEST,{...MANIFEST,version:forbidden}),
      /MANUAL VERSION CHANGE BLOCKED/);
  }
});

test('manual lockfile root or top-level version edits cannot bypass manifest check',()=>{
  const old=lock(),changedTop=lock(),changedRoot=lock();
  changedTop.version='2.9.0';
  changedRoot.packages[''].version='2.9.0';
  assert.throws(()=>compareLockVersions(old,changedTop,'2.8.0'),/root versions must match/);
  assert.throws(()=>compareLockVersions(old,changedRoot,'2.8.0'),/root versions must match/);
  assert.throws(()=>compareLockVersions(old,null,'2.8.0'),/must remain present/);
});

test('current main baseline is accepted despite older historical formal releases',()=>{
  const f=createRepo();
  try{
    // A normal working tree on main MUST NOT compare to HEAD^: it might have
    // historically used manual baseline releases before the policy existed.
    assert.equal(determineBaseRef({cwd:f.cwd,env:{}}),f.base);
    assert.equal(checkVersionPolicy({cwd:f.cwd,env:{}}).version,'2.8.0');
  } finally {f.clean();}
});

test('locally uncommitted npm version-style edits are rejected',()=>{
  const f=createRepo();
  try {
    f.put('package.json',{...MANIFEST,version:'2.8.1'});
    assert.throws(()=>checkVersionPolicy({cwd:f.cwd,env:{}}),
      /MANUAL VERSION CHANGE BLOCKED/);
  } finally {f.clean();}
});

test('entire feature branch is checked, not just most recent commit',()=>{
  const f=createRepo();
  try{
    execute(f.cwd,'switch','-c','feature/fake-manual-version');
    f.put('package.json',{...MANIFEST,version:'2.9.0'});
    f.put('package-lock.json',lock('2.9.0'));
    f.commit('Oops: manual minor version');
    // Second commit leaves the version unchanged; a HEAD^ diff would miss it.
    fs.writeFileSync(path.join(f.cwd,'some-feature.js'),"'use strict';\n");
    f.commit('Feature logic (no manifest diff in latest commit)');
    assert.equal(determineBaseRef({cwd:f.cwd,env:{}}),f.base);
    assert.throws(()=>checkVersionPolicy({cwd:f.cwd,env:{}}),
      /MANUAL VERSION CHANGE BLOCKED/);
    assert.throws(()=>checkVersionPolicy({
      cwd:f.cwd,env:{VERSION_POLICY_BASE_SHA:f.base},
    }),/MANUAL VERSION CHANGE BLOCKED/);
  } finally {f.clean();}
});

test('CI compare-base override fails closed for invalid or unavailable SHA',()=>{
  const f=createRepo();
  try{
    assert.throws(()=>checkVersionPolicy({cwd:f.cwd,env:{
      VERSION_POLICY_BASE_SHA:'not-a-sha',
    }}),/valid 40-character/);
    assert.throws(()=>checkVersionPolicy({cwd:f.cwd,env:{
      VERSION_POLICY_BASE_SHA:'abcdefab'.repeat(5),
    }}),/could not inspect Git/);
    assert.equal(checkVersionPolicy({
      cwd:f.cwd,env:{VERSION_POLICY_BASE_SHA:f.base},
    }).version,'2.8.0');
  } finally {f.clean();}
});

test('code and dependency edits remain valid without any manual version edits',()=>{
  const f=createRepo();
  try {
    execute(f.cwd,'switch','-c','feature/new-functionality');
    fs.writeFileSync(path.join(f.cwd,'feature.js'),'module.exports = true;\n');
    f.put('package.json',{
      ...MANIFEST,dependencies:{...MANIFEST.dependencies,'luxon':'^3.7.2'},
    });
    const newLock=lock();
    newLock.packages[''].dependencies.luxon='^3.7.2';
    f.put('package-lock.json',newLock);
    f.commit('Add source file and dependency without version bump');
    assert.equal(checkVersionPolicy({cwd:f.cwd,env:{
      VERSION_POLICY_BASE_SHA:f.base,
    }}).version,'2.8.0');
  }finally{f.clean();}
});


test('pinned package baseline still catches old illegal version on a later clean push',()=>{
  const f=createRepo();
  try {
    // A previous commit illegally bumps the package version; a later commit
    // has no further manifest diff and the push-before SHA would be too late.
    f.put('package.json',{...MANIFEST,version:'2.9.0'});
    f.put('package-lock.json',lock('2.9.0'));
    f.commit('Accidental manual release was previously pushed');
    const illegallyChangedBase=execute(f.cwd,'rev-parse','HEAD');
    fs.writeFileSync(path.join(f.cwd,'fix.js'),'module.exports = 1;\n');
    f.commit('Unrelated follow-up push');
    const head=execute(f.cwd,'rev-parse','HEAD');
    execute(f.cwd,'update-ref','refs/remotes/origin/main',head);
    // The immediate previous-commit comparison sees matching 2.9.0 values.
    // The permanent known baseline must still reject this entire checkout.
    assert.throws(()=>checkVersionPolicy({cwd:f.cwd,env:{
      VERSION_POLICY_BASE_SHA:illegallyChangedBase,
    }}),/frozen historical manifest baseline/);
    assert.throws(()=>checkVersionPolicy({cwd:f.cwd,env:{}}),
      /frozen historical manifest baseline/);
  } finally {f.clean();}
});

test('an accidentally tracked .versionState.json is also rejected',()=>{
  const f=createRepo();
  try {
    fs.writeFileSync(path.join(f.cwd,'.versionState.json'),'{"version":"9.9.9"}\n');
    execute(f.cwd,'add','-f','.versionState.json');
    f.commit('Mistakenly checked in installation version state');
    assert.throws(()=>checkVersionPolicy({cwd:f.cwd,env:{}}),
      /must never be tracked or committed/);
  } finally {f.clean();}
});


test('GitHub CI keeps an independent mandatory version-policy job before other checks',()=>{
  const workflow = fs.readFileSync(path.join(__dirname,'..','.github','workflows','test.yml'),'utf8');
  assert.match(workflow,/^  version-policy:\s*$/m);
  assert.match(workflow,/^    name: version-policy\s*$/m);
  assert.match(workflow,/^    needs: version-policy\s*$/m);
  assert.match(workflow,/run: node scripts\/checkVersionPolicy\.js/);
  assert.match(workflow,/VERSION_POLICY_BASE_SHA:/);
  assert.match(workflow,/fetch-depth: 0/);
});
