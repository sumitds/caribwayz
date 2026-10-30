import api from './axios';

// Public, no login: the /membership page (docs/members-contract.md).
export const getPublicMembershipTiers = () => api.get('/members/tiers');
export const applyForMembership = (data) => api.post('/members/apply', data);
