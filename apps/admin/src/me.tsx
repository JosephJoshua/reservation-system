import { can, type StaffDto, type StaffPermission } from '@rs/shared'
import { createContext, useContext } from 'react'

/** Fired when staff details may have changed, so App loads the signed-in member again. */
export const STAFF_CHANGED = 'staff-changed'

/** The signed-in staff member, loaded once by App. */
export const MeContext = createContext<StaffDto | null>(null)

export function useMe() {
  return useContext(MeContext)
}

/** Whether the signed-in staff member may do this. False until /admin/me has loaded. */
export function useCan(permission: StaffPermission) {
  const me = useContext(MeContext)
  return me !== null && can(me.roles, permission)
}
