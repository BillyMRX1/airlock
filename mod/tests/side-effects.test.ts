import { test, expect, describe } from 'claude-code/testing'
import { classifySideEffect } from '../hooks/tools/side-effects.ts'

describe('side-effect classifier', () => {
  test('matches git push (incl. --force)', () => {
    expect(classifySideEffect('git push origin main').matched).toBe(true)
    expect(classifySideEffect('git push --force-with-lease origin main').matched).toBe(true)
    expect(classifySideEffect('git push').pattern).toBe('git push')
  })

  test('matches package publishing', () => {
    expect(classifySideEffect('npm publish --access public').matched).toBe(true)
    expect(classifySideEffect('yarn publish --tag next').matched).toBe(true)
    expect(classifySideEffect('twine upload dist/*').matched).toBe(true)
  })

  test('matches docker destruction', () => {
    expect(classifySideEffect('docker system prune -af').matched).toBe(true)
    expect(classifySideEffect('docker rm -f web').matched).toBe(true)
    expect(classifySideEffect('docker volume rm cache').matched).toBe(true)
  })

  test('matches kubectl and terraform mutations', () => {
    expect(classifySideEffect('kubectl delete pod foo').matched).toBe(true)
    expect(classifySideEffect('kubectl apply -f k8s.yaml').matched).toBe(true)
    expect(classifySideEffect('terraform apply -auto-approve').matched).toBe(true)
    expect(classifySideEffect('terraform destroy').matched).toBe(true)
  })

  test('matches cloud CLIs', () => {
    expect(classifySideEffect('aws s3 rm s3://bucket/key').matched).toBe(true)
    expect(classifySideEffect('gcloud projects delete my-project').matched).toBe(true)
    expect(classifySideEffect('az group delete --name rg').matched).toBe(true)
  })

  test('matches HTTP writes but not plain GETs', () => {
    expect(classifySideEffect('curl -X POST https://api.example.com/v1/x').matched).toBe(true)
    expect(classifySideEffect('curl -d @file https://api.example.com/v1/x').matched).toBe(true)
    expect(classifySideEffect('curl https://example.com/data.json').matched).toBe(false)
    expect(classifySideEffect('wget https://example.com/file.tar.gz').matched).toBe(false)
  })

  test('matches remote ssh/scp', () => {
    expect(classifySideEffect('ssh deploy@prod.example.com restart').matched).toBe(true)
    expect(classifySideEffect('scp -r ./dist deploy@prod.example.com:/srv').matched).toBe(true)
    expect(classifySideEffect('rsync -a ./dist deploy@prod.example.com:/srv').matched).toBe(true)
  })

  test('matches database -c execution', () => {
    expect(classifySideEffect('psql -d mydb -c "DROP TABLE users"').matched).toBe(true)
    expect(classifySideEffect('mysql -u root -c "DELETE FROM users"').matched).toBe(true)
  })

  test('does not match ordinary local commands', () => {
    expect(classifySideEffect('git status').matched).toBe(false)
    expect(classifySideEffect('npm test').matched).toBe(false)
    expect(classifySideEffect('node test.js').matched).toBe(false)
    expect(classifySideEffect('ls -la').matched).toBe(false)
    expect(classifySideEffect('docker ps').matched).toBe(false)
    expect(classifySideEffect('docker build -t x .').matched).toBe(false)
  })

  test('returns the matching pattern and reason', () => {
    const m = classifySideEffect('npm publish')
    expect(m.matched).toBe(true)
    expect(m.pattern).toBe('npm publish')
    expect(typeof m.reason).toBe('string')
    expect(m.reason.length).toBeGreaterThan(0)
  })
})
