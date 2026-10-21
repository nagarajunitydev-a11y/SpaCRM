package com.luxeglow.crm;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.RadialGradient;
import android.graphics.RectF;
import android.graphics.Shader;
import android.graphics.Typeface;
import android.view.View;

/** Native branded splash overlay: available before the network or hosted scripts load. Static, no loading animation. */
final class LoadingScreenView extends View {
    private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG | Paint.FILTER_BITMAP_FLAG);
    private final Bitmap logo;
    private final RectF bounds = new RectF();
    private final Typeface titleFont = Typeface.create("sans-serif-medium", Typeface.NORMAL);
    private final Shader centerGlow = new RadialGradient(0, -52, 170, 0x282F3684, Color.TRANSPARENT, Shader.TileMode.CLAMP);
    private Shader purpleGlow, magentaGlow, pinkGlow;

    LoadingScreenView(Context context) {
        super(context);
        logo = BitmapFactory.decodeResource(getResources(), R.drawable.glowos_logo);
        setContentDescription(context.getString(R.string.loading_screen_description));
        setImportantForAccessibility(IMPORTANT_FOR_ACCESSIBILITY_YES);
        setClickable(true);
    }

    @Override protected void onSizeChanged(int width, int height, int oldWidth, int oldHeight) {
        super.onSizeChanged(width, height, oldWidth, oldHeight);
        if (width <= 0 || height <= 0) return;
        purpleGlow = new RadialGradient(width * .08f, height * .14f, width * .95f, 0x403F176D, Color.TRANSPARENT, Shader.TileMode.CLAMP);
        magentaGlow = new RadialGradient(width * .98f, height * .85f, width * .9f, 0x382E0C46, Color.TRANSPARENT, Shader.TileMode.CLAMP);
        pinkGlow = new RadialGradient(width * .88f, height * .9f, width * .55f, 0x30D71A82, Color.TRANSPARENT, Shader.TileMode.CLAMP);
    }

    @Override protected void onDraw(Canvas canvas) {
        super.onDraw(canvas);
        float width = getWidth(), height = getHeight();
        canvas.drawColor(Color.rgb(2, 6, 23));
        glow(canvas, purpleGlow);
        glow(canvas, magentaGlow);
        glow(canvas, pinkGlow);

        // Scale the entire composition to fit narrow, short and large screens.
        float scale = Math.min(width / 400f, height / 720f);
        canvas.save();
        canvas.translate(width / 2f, height / 2f);
        canvas.scale(scale, scale);
        paint.setShader(centerGlow);
        canvas.drawCircle(0, -52, 170, paint);
        paint.setShader(null);
        bounds.set(-120, -192, 120, 48);
        // The square transparent source is drawn intact, without cropping/stretching.
        canvas.drawBitmap(logo, null, bounds, paint);

        paint.setTypeface(titleFont);
        paint.setTextSize(32);
        paint.setTextAlign(Paint.Align.CENTER);
        paint.setColor(Color.WHITE);
        canvas.drawText("Qvrix GlowOS", 0, 85, paint);
        canvas.restore();
    }

    private void glow(Canvas canvas, Shader shader) {
        if (shader == null) return;
        paint.setShader(shader);
        canvas.drawPaint(paint);
        paint.setShader(null);
    }
}
