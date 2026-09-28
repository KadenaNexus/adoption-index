import pg from 'pg';
// Calendar days must not shift when the process runs outside UTC.
pg.types.setTypeParser(1082,value=>value);
export function database(connectionString=process.env.DATABASE_URL){
 if(!connectionString)throw new Error('DATABASE_URL is required');
 return new pg.Pool({connectionString,max:8,connectionTimeoutMillis:10000,application_name:'kce-adoption-index'});
}
export async function transaction(pool,fn){const client=await pool.connect();try{await client.query('BEGIN');const value=await fn(client);await client.query('COMMIT');return value}catch(error){await client.query('ROLLBACK');throw error}finally{client.release()}}
