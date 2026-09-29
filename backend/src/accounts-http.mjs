import {requestLoginLink,verifyLinkToken,verifyLoginCode,revokeSession,accountView,addAlert,deleteAlert} from './accounts.mjs';
import {adminOverview,adminExtend,resolveUnmatched} from './admin.mjs';
// server.mjs enforces the site key on all of these, a session on every route outside PUBLIC_ROUTES and an admin on
// /admin/; handlers still ask for what they use.
export const routes={
 'POST /auth/request-link':async({db,cfg,mailer,body,clientIp,now})=>{await requestLoginLink(db,cfg,mailer,{email:body.email,next:body.next,clientIp,now});return {status:202,body:{ok:true}}},
 'POST /auth/verify':async({db,body,now})=>({status:200,body:await verifyLinkToken(db,{token:body.token,now})}),
 'POST /auth/verify-code':async({db,body,now})=>({status:200,body:await verifyLoginCode(db,{email:body.email,code:body.code,now})}),
 // Signing out needs neither a body nor a live session: without one there is nothing to revoke.
 'POST /auth/logout':async({db,session,now})=>{if(session)await revokeSession(db,session.sessionHash,now);return {status:200,body:{ok:true}}},
 'GET /account':async ctx=>({status:200,body:await accountView(ctx.db,ctx.cfg,ctx.requireSession())}),
 'POST /account/alerts':async ctx=>({status:201,body:await addAlert(ctx.db,ctx.requireSubscriber().user.id,ctx.body)}),
 'POST /account/alerts/delete':async ctx=>({status:200,body:await deleteAlert(ctx.db,ctx.requireSession().user.id,ctx.body)}),
 'GET /admin/overview':async ctx=>{ctx.requireAdmin();return {status:200,body:await adminOverview(ctx.db,ctx.cfg,{now:ctx.now})}},
 'POST /admin/subscriptions/extend':async ctx=>({status:200,body:await adminExtend(ctx.db,ctx.requireAdmin().user.email,ctx.body,{now:ctx.now})}),
 'POST /admin/unmatched/resolve':async ctx=>({status:200,body:await resolveUnmatched(ctx.db,ctx.cfg,ctx.requireAdmin().user.email,ctx.body,{now:ctx.now})}),
};
