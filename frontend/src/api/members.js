import api from './axios';

// Public, no login: the /membership page (docs/members-contract.md).
export const getPublicMembershipTiers = () => api.get('/members/tiers');
export const applyForMembership = (data) => api.post('/members/apply', data);

// Admin: membership add-ons (migration 034, docs/members-contract.md).
export const getMemberCampaigns = (params) => api.get('/admin/membership-campaigns', { params });
export const addMemberCampaign = (data) => api.post('/admin/membership-campaigns', data);
export const updateMemberCampaign = (id, data) => api.patch(`/admin/membership-campaigns/${id}`, data);
export const endMemberCampaign = (id) => api.post(`/admin/membership-campaigns/${id}/end`, {});
export const deleteMemberCampaign = (id) => api.delete(`/admin/membership-campaigns/${id}`);

export const getMembershipRenewals = () => api.get('/admin/membership-renewals');
export const sendRenewalReminder = (id, { resend = false } = {}) => api.post(`/admin/membership-renewals/${id}/remind`, { resend });
