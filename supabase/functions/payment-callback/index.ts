// ============================================
// Edge Function: payment-callback
// 处理支付渠道回调（通用模板）
// ============================================

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.44.0';
import { crypto } from 'https://deno.land/std@0.177.0/crypto/mod.ts';

serve(async (req) => {
  // 支付回调通常为 POST
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  try {
    // 创建 Supabase 客户端
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

    const supabase = createClient(supabaseUrl, supabaseServiceKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    });

    // 解析回调数据（根据实际支付渠道调整）
    const body = await req.text();
    const params = new URLSearchParams(body);

    // TODO: 根据实际支付渠道实现验签逻辑
    // 示例：微信支付
    // const sign = params.get('sign');
    // const calculatedSign = calculateWechatSign(params, apiKey);
    // if (sign !== calculatedSign) {
    //   return new Response('Invalid signature', { status: 400 });
    // }

    const bizNo = params.get('out_trade_no');
    const transactionId = params.get('transaction_id');
    const resultCode = params.get('result_code');
    const totalFee = params.get('total_fee');

    if (!bizNo) {
      return new Response('Missing biz_no', { status: 400 });
    }

    // 幂等性检查：查询是否已处理
    const { data: existingTx } = await supabase
      .from('wallet_transactions')
      .select('id, status')
      .eq('biz_no', bizNo)
      .eq('status', 'success')
      .single();

    if (existingTx) {
      // 已处理，直接返回成功
      return new Response('SUCCESS', { status: 200 });
    }

    if (resultCode === 'SUCCESS') {
      // 支付成功，更新钱包余额和流水状态
      const amount = parseInt(totalFee || '0') / 100; // 转换为元

      // TODO: 调用数据库函数完成入账
      // const { error } = await supabase.rpc('process_payment_success', {
      //   p_biz_no: bizNo,
      //   p_amount: amount,
      //   p_ext: { transaction_id: transactionId }
      // });

      console.log(`Payment success: biz_no=${bizNo}, amount=${amount}`);
    } else {
      // 支付失败，更新流水状态
      await supabase
        .from('wallet_transactions')
        .update({ status: 'failed', ext: { error: resultCode } })
        .eq('biz_no', bizNo);
    }

    // 返回支付渠道要求的响应格式
    return new Response('SUCCESS', { status: 200 });
  } catch (error) {
    console.error('Payment callback error:', error);
    return new Response('Internal error', { status: 500 });
  }
});

// 微信支付签名计算示例
function calculateWechatSign(params: URLSearchParams, apiKey: string): string {
  // 1. 过滤空值和 sign 字段
  // 2. 按键名 ASCII 排序
  // 3. 拼接成字符串
  // 4. 末尾追加 &key=apiKey
  // 5. MD5 加密并转大写
  // TODO: 实现具体逻辑
  return '';
}