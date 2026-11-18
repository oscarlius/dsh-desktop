import { describe, expect, it } from 'vitest'
import { renderEmployeeProfile } from '../src/employee-profile.js'
import type { WebAccountFile } from '../src/web-account.js'

const account: WebAccountFile = {
  origin: 'https://portal.example.test', instanceToken: 'p7wi_test', expiresAt: 10_000,
  tokenType: 'Bearer', instanceId: 'test-instance', generation: 2,
  profile: { organizationId: 'org-a', userId: 'employee-a', displayName: '示例员工',
    role: 'employee', deviceId: 'web-browser', sessionId: 'session-a', scopes: [] },
}
const envelope = {
  schema: 1, organizationId: 'org-a', userId: 'employee-a', instanceId: 'test-instance', generation: 2,
  profile: { displayName: '示例员工', department: '业务部', position: '测试岗',
    duties: ['维护测试系统'], manager: { displayName: '示例主管', position: '部门负责人' },
    enterpriseEmail: 'unneeded@example.test', accessToken: 'unneeded' },
}
const structured = {
  ...envelope,
  profile: {
    displayName: '示例员工', directoryDepartment: '飞书目录示例部', grade: '示例级',
    manager: { displayName: '整体主管', department: '整体主管部门' },
    assignments: [
      { position: '测试岗', department: '工程组', status: 'confirmed', duties: ['维护测试系统'],
        manager: { displayName: '测试岗主管', department: '工程组', position: '组长', accessToken: 'never-render' },
      },
      { position: '支持岗', status: 'confirmed', duties: ['答复支持申请'], unexpected: 'never-render' },
      { position: '计划岗', status: 'pending', duties: ['never-render-pending-duty'],
        manager: { displayName: 'never-render-pending-manager' },
      },
    ],
    enterpriseEmail: 'never-render@example.test',
  },
}

describe('employee profile initialization', () => {
  it('renders only the permitted fields with the verified workspace identity', () => {
    const prompt = renderEmployeeProfile(envelope, account, 1000)
    expect(prompt).toContain('示例员工')
    expect(prompt).toContain('示例主管')
    expect(prompt).toContain('维护测试系统')
    expect(prompt).not.toContain('unneeded')
    expect(prompt).not.toContain(account.instanceToken)
  })

  it('drops profiles for another employee, instance, generation or expired credential', () => {
    for (const record of [
      { ...envelope, organizationId: 'org-b' },
      { ...envelope, userId: 'employee-b' },
      { ...envelope, instanceId: 'other' },
      { ...envelope, generation: 1 },
      { ...envelope, profile: { ...envelope.profile, displayName: '另一个人' } },
    ]) expect(renderEmployeeProfile(record, account, 1000)).toBe('')
    expect(renderEmployeeProfile(envelope, account, 10_000)).toBe('')
  })

  it('separates directory affiliation, confirmed work and reporting lines, and pending roles', () => {
    const prompt = renderEmployeeProfile({
      ...structured,
      profile: { ...structured.profile, department: 'never-render', position: 'never-render', duties: ['never-render'] },
    }, account, 1000)
    const [instructions = '', data = ''] = prompt.split('\n')
    expect(instructions).toContain('最相关的已确认岗位')
    expect(instructions).toContain('不根据档案推断职责调整、授权或访问权限')
    expect(JSON.parse(data)).toEqual({
      姓名: '示例员工', 飞书通讯录部门: '飞书目录示例部', 职级: '示例级',
      整体直接上级: { 姓名: '整体主管', 部门: '整体主管部门' },
      岗位分工: [
        { 岗位: '测试岗', 岗位所属部门: '工程组', 状态: '已确认', 已确认职责: ['维护测试系统'],
          岗位直接汇报对象: { 姓名: '测试岗主管', 部门: '工程组', 岗位: '组长' } },
        { 岗位: '支持岗', 状态: '已确认', 已确认职责: ['答复支持申请'] },
        { 岗位: '计划岗', 状态: '待确认（不能作为当前岗位依据）' },
      ],
    })
    expect(prompt).not.toContain('never-render')
    expect(renderEmployeeProfile({ ...structured, generation: 1 }, account, 1000)).toBe('')
  })

  it('rejects malformed or oversized assignments without falling back to the legacy fields', () => {
    const valid = { position: '测试岗', status: 'confirmed', duties: ['维护测试系统'] }
    for (const assignments of [
      null, 'invalid', Array(9).fill(valid), [null],
      [{ ...valid, position: '\u0001bad' }], [{ ...valid, status: 'other' }],
      [{ ...valid, duties: 'invalid' }], [{ ...valid, duties: Array(13).fill('duty') }],
      [{ ...valid, duties: [false] }], [{ ...valid, duties: ['x'.repeat(501)] }],
    ]) {
      expect(renderEmployeeProfile({
        ...structured, profile: { ...envelope.profile, directoryDepartment: '飞书目录示例部', assignments },
      }, account, 1000)).toBe('')
    }
    expect(renderEmployeeProfile({ ...structured, profile: { ...structured.profile, directoryDepartment: '' } }, account, 1000)).toBe('')
  })
})
